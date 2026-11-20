import { z } from "zod";
import type { CalendarEvent } from "../../../apps/desktop/src/core/repositories/models";
import type {
  AiActionDefinition,
  AiActionGroup,
  AiContext,
  AiTarget,
  JsonSchemaObject,
  Prepared,
  RefEntry,
  SeriesScope,
} from "../../../apps/desktop/src/core/ai/action-types";
import { formatLocalTime, parseLocalTime } from "../../../apps/desktop/src/core/ai/local-time";
import { deleteSeries } from "../../../apps/desktop/src/core/calendar/series-mutations";
import { generalApi, isFinanceReminder, type GeneralApi } from "./api";
import {
  aiRepeatDraft,
  aiRepeatSchema,
  eventCreateArgsSchema,
  nearestAiReminder,
  parseAiCreateDraft,
  validateAiCreateDraft,
  type AiCreateDraft,
} from "./ai-create-model";
import { draftPatch, occurrenceDraft, scopedPatch, shiftDay, toggleAllDay } from "./calendar-model";
import { reminderFields, reminderForm } from "./reminder-model";
import { AiMutationPreview } from "./components/AiMutationPreview";
import {
  aiMutationDiff,
  aiMutationWhen,
  type AiMutationDraft,
  type AiMutationItem,
  type AiMutationKind,
} from "./ai-mutation-model";

const refsSchema = z
  .array(z.string().regex(/^[er][1-9]\d*$/))
  .min(1)
  .max(20)
  .refine((refs) => new Set(refs).size === refs.length);
const eventChanges = eventCreateArgsSchema
  .omit({ duration_minutes: true })
  .partial()
  .extend({ repeat: aiRepeatSchema.nullable().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
const reminderChanges = z
  .object({
    title: eventCreateArgsSchema.shape.title.optional(),
    notes: z.string().optional(),
    due: eventCreateArgsSchema.shape.start.nullable().optional(),
    repeat: aiRepeatSchema.nullable().optional(),
    priority: z.number().int().min(0).max(3).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export const eventUpdateArgsSchema = z.object({ refs: refsSchema, changes: eventChanges }).strict();
export const reminderUpdateArgsSchema = z
  .object({ refs: refsSchema, changes: reminderChanges })
  .strict();
export const aiDeleteArgsSchema = z
  .object({ refs: refsSchema, mode: z.enum(["pick_one", "all_listed"]) })
  .strict();

type EventState = Awaited<ReturnType<GeneralApi["aiEventState"]>>;
type ReminderState = Awaited<ReturnType<GeneralApi["aiReminderState"]>>;
type EventItem = { ref: RefEntry; state: EventState; display: AiMutationItem };
type ReminderItem = { ref: RefEntry; state: ReminderState; display: AiMutationItem };
type Plan = {
  kind: AiMutationKind;
  ctx: AiContext;
  events: EventItem[];
  reminders: ReminderItem[];
  original: AiMutationDraft;
  completed: Set<string>;
  eventVersions: Map<string, CalendarEvent>;
  lockedSelection?: string[];
  lockedScope?: SeriesScope;
};
class MutationError extends Error {
  constructor(
    message: string,
    readonly target?: AiTarget,
  ) {
    super(message);
  }
}
const changed = () => new MutationError("内容已变化，请重新说一次");
const missingRef = () => new MutationError("AI 指向了不存在的项目，请重新说一次");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fail = (error: unknown): Prepared<AiMutationDraft> => ({
  type: "error",
  message:
    error instanceof MutationError
      ? error.message
      : error instanceof z.ZodError
        ? "AI 返回的修改或删除参数无效，请换个说法"
        : "无法准备这个操作，请重试或手动操作",
  fallback: "manual",
  ...(error instanceof MutationError && error.target ? { target: error.target } : {}),
});
const whenParameter = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2})?$",
  description: "本地时间或日期，不含时区偏移",
};
const repeatParameter = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        preset: { type: "string", enum: ["daily", "workdays", "weekly", "monthly", "yearly"] },
        weekdays: {
          type: "array",
          items: { type: "integer", minimum: 1, maximum: 7 },
          minItems: 1,
          maxItems: 7,
        },
        end: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: { type: { const: "never" } },
              required: ["type"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { const: "until" },
                until: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              },
              required: ["type", "until"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { const: "count" },
                count: { type: "integer", minimum: 1, maximum: 999 },
              },
              required: ["type", "count"],
            },
          ],
        },
      },
      required: ["preset"],
    },
  ],
  description: "null取消重复；weekly星期1=周一至7=周日，不能输出RRULE",
};
function parameters(changes?: Record<string, unknown>): JsonSchemaObject {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      refs: {
        type: "array",
        items: { type: "string", pattern: "^[er][1-9]\\d*$" },
        minItems: 1,
        maxItems: 20,
        uniqueItems: true,
      },
      ...(changes
        ? {
            changes: {
              type: "object",
              properties: changes,
              additionalProperties: false,
              minProperties: 1,
            },
          }
        : { mode: { type: "string", enum: ["pick_one", "all_listed"] } }),
    },
    required: ["refs", changes ? "changes" : "mode"],
  };
}

/** 所有目标、原值和并发快照仅在本地闭包中保存；模型参数不能指定真实记录 ID。 */
export function createAiMutationActions(api: GeneralApi = generalApi): AiActionGroup["actions"] {
  const plans = new Map<string, Plan>();
  function reference(ref: string, kind: "event" | "reminder", ctx: AiContext): RefEntry {
    const entry = ctx.refs.resolve(ref, kind);
    if (!entry || entry.target.kind !== kind) throw missingRef();
    return entry;
  }
  async function eventItem(
    ref: string,
    ctx: AiContext,
    ownSnapshot?: CalendarEvent,
  ): Promise<EventItem> {
    const entry = reference(ref, "event", ctx);
    if (entry.target.kind !== "event") throw missingRef();
    let state: EventState;
    try {
      state = await api.aiEventState(entry.target.eventId, entry.target.originalStart);
    } catch {
      throw new MutationError("这条已经不存在了");
    }
    if (
      state.series.updated_at !== (ownSnapshot?.updated_at ?? entry.updatedAt) ||
      !same(entry.related ?? [], state.related)
    )
      throw changed();
    const original = occurrenceDraft(state.occurrence, state.series);
    const repeating = state.series.rrule !== null;
    const first =
      repeating &&
      deleteSeries(
        { series: state.series, exceptions: state.exceptions },
        state.occurrence.original_start_at,
        "following",
        { now: ctx.now, deviceId: state.series.device_id, newId: "preview" },
      ).updated.some((row) => row.id === state.series.id && row.deleted_at !== null);
    return {
      ref: entry,
      state,
      display: {
        id: ref,
        target: entry.target,
        title: state.occurrence.event.title,
        when: `${aiMutationWhen(original.start, original.zone)} — ${aiMutationWhen(original.end, original.zone)}`,
        repeating,
        first,
      },
    };
  }
  async function reminderItem(ref: string, ctx: AiContext): Promise<ReminderItem> {
    const entry = reference(ref, "reminder", ctx);
    if (entry.target.kind !== "reminder") throw missingRef();
    let state: ReminderState;
    try {
      state = await api.aiReminderState(entry.target.reminderId, entry.target.occurrenceId);
    } catch {
      throw new MutationError("这条已经不存在了");
    }
    if (state.reminder.updated_at !== entry.updatedAt) throw changed();
    if (state.reminder.source === "event")
      throw new MutationError("这条提醒由日程生成，请修改对应日程", state.linkedTarget);
    if (isFinanceReminder(state.reminder))
      throw new MutationError("金融提醒只能查询，不能通过 AI 修改或删除");
    const value = state.occurrence?.due_at ?? state.reminder.due_at;
    return {
      ref: entry,
      state,
      display: {
        id: ref,
        target: entry.target,
        title: state.reminder.title,
        when:
          value === null
            ? "无到期时间"
            : aiMutationWhen(
                formatLocalTime(value, state.reminder.timezone),
                state.reminder.timezone,
              ),
        repeating: state.reminder.rrule !== null,
        first: false,
      },
    };
  }
  async function resolveAll(refs: string[], kind: "event" | "reminder", ctx: AiContext) {
    // 先检查全部 ref，再读取全部目标；任何一项无效都不生成候选或部分卡片。
    for (const ref of refs) reference(ref, kind, ctx);
    return kind === "event"
      ? Promise.all(refs.map((ref) => eventItem(ref, ctx)))
      : Promise.all(refs.map((ref) => reminderItem(ref, ctx)));
  }
  function savePlan(
    kind: AiMutationKind,
    ctx: AiContext,
    events: EventItem[],
    reminders: ReminderItem[],
    initial?: AiCreateDraft,
    next?: AiCreateDraft,
    note?: string,
  ): Prepared<AiMutationDraft> {
    // 取消卡片没有后续回调；新提案到达时清理引用已全部过期或清空的计划。
    for (const [token, plan] of plans) {
      if (
        ![...plan.events, ...plan.reminders].some((item) =>
          plan.ctx.refs.resolve(item.ref.ref, item.ref.target.kind),
        )
      )
        plans.delete(token);
    }
    const items = [...events, ...reminders].map((item) => item.display);
    const token = crypto.randomUUID();
    const draft: AiMutationDraft = {
      kind,
      token,
      items: structuredClone(items),
      selectedIds: items.map((item) => item.id),
      ...(initial && next
        ? { initial: structuredClone(initial), next: structuredClone(next) }
        : {}),
    };
    if (kind.endsWith("update") && !aiMutationDiff(draft).length)
      return { type: "error", message: "没有需要修改的字段", fallback: "manual" };
    plans.set(token, {
      kind,
      ctx,
      events,
      reminders,
      original: structuredClone(draft),
      completed: new Set(),
      eventVersions: new Map(),
    });
    return {
      type: "proposal",
      draft,
      ...(note ? { note } : {}),
      ...(kind.endsWith("update")
        ? { diff: aiMutationDiff(draft) }
        : { selections: items.map(({ id, title, when }) => ({ id, title, when })) }),
      needsScope: events.some((item) => item.display.repeating),
    };
  }
  function validate(draft: AiMutationDraft): string[] {
    if (!draft || typeof draft !== "object") return ["草稿无效，请重新查询"];
    const plan = plans.get(draft.token);
    if (
      !plan ||
      draft.kind !== plan.kind ||
      !same(draft.items, plan.original.items) ||
      !same(draft.initial, plan.original.initial)
    )
      return ["草稿目标或原值无效，请重新查询"];
    if (
      !Array.isArray(draft.selectedIds) ||
      draft.selectedIds.length < 1 ||
      new Set(draft.selectedIds).size !== draft.selectedIds.length ||
      draft.selectedIds.some((id) => !plan.original.selectedIds.includes(id))
    )
      return ["请至少选择一个有效项目"];
    if (plan.lockedSelection && !same(draft.selectedIds, plan.lockedSelection))
      return ["已有项目已删除，请保持原选择继续重试，或重新查询"];
    if (plan.original.next) {
      if (draft.next?.type !== plan.original.next.type || draft.selectedIds.length !== 1)
        return ["修改草稿类型无效"];
      const initial = plan.original.initial;
      const errors = validateAiCreateDraft(
        draft.next,
        initial?.type === "event" ? initial.form : undefined,
      );
      if (errors.length) return errors;
      if (!aiMutationDiff(draft).length) return ["没有需要修改的字段"];
    } else if (draft.next !== undefined) return ["删除卡片不允许修改项目内容"];
    return [];
  }
  async function execute(draft: AiMutationDraft, scope?: SeriesScope) {
    const errors = validate(draft);
    if (errors.length) throw new Error(errors[0]);
    const plan = plans.get(draft.token)!;
    if (plan.completed.size && plan.lockedScope !== scope)
      throw new Error("已有项目已删除，请保持原范围继续重试，或重新查询");
    const selected = new Set(draft.selectedIds);
    const events = plan.events.filter((item) => selected.has(item.display.id));
    const reminders = plan.reminders.filter((item) => selected.has(item.display.id));
    if (events.some((item) => item.display.repeating) && !scope)
      throw new Error("请选择重复日程的作用范围");
    // 确认前重查全部选中项目；一个已变动时，整张卡片都不开始写入。
    for (const item of events) {
      if (plan.completed.has(item.display.id)) continue;
      const ownSnapshot = plan.eventVersions.get(item.state.series.id);
      const fresh = await eventItem(item.ref.ref, plan.ctx, ownSnapshot);
      if (
        !same(fresh.state.series, ownSnapshot ?? item.state.series) ||
        (item.state.occurrence.is_exception &&
          !same(fresh.state.occurrence.event, item.state.occurrence.event))
      )
        throw changed();
    }
    for (const item of reminders) {
      if (plan.completed.has(item.display.id)) continue;
      const fresh = await reminderItem(item.ref.ref, plan.ctx);
      if (!same(fresh.state.reminder, item.state.reminder)) throw changed();
    }
    try {
      if (
        draft.kind === "event-update" &&
        draft.next?.type === "event" &&
        draft.initial?.type === "event"
      ) {
        const item = events[0]!;
        const patch = draftPatch(draft.next.form, draft.initial.form);
        const expected = { updatedAt: item.ref.updatedAt, related: item.ref.related ?? [] };
        if (item.display.repeating) {
          const saved = await api.editEventOccurrenceChecked(
            item.state.series.id,
            item.state.occurrence.original_start_at,
            scope!,
            scopedPatch(patch, item.state.occurrence, item.state.series, scope!),
            expected,
          );
          return {
            message: "已修改日程",
            target: {
              kind: "event" as const,
              eventId: saved.id,
              originalStart: scope === "this" ? item.state.occurrence.original_start_at : null,
            },
          };
        }
        await api.updateEvent(item.state.series.id, patch, expected);
        return { message: "已修改日程", target: item.ref.target };
      }
      if (
        draft.kind === "reminder-update" &&
        draft.next?.type === "reminder" &&
        draft.initial?.type === "reminder"
      ) {
        const item = reminders[0]!;
        await api.saveReminder(
          item.state.reminder.id,
          reminderFields(draft.next.form, draft.initial.form, item.state.reminder),
          item.state.reminder,
        );
        return {
          message: "已修改提醒",
          target: {
            kind: "reminder" as const,
            reminderId: item.state.reminder.id,
            occurrenceId: null,
          },
        };
      }
      const remember = (ids: string[]) => {
        for (const id of ids) plan.completed.add(id);
        plan.lockedSelection ??= [...draft.selectedIds];
        if (scope !== undefined) plan.lockedScope = scope;
      };
      for (const item of [...events].sort(
        (a, b) => a.state.occurrence.original_start_at - b.state.occurrence.original_start_at,
      )) {
        const id = item.state.series.id;
        if (plan.completed.has(item.display.id)) continue;
        const expected = {
          updatedAt: plan.eventVersions.get(id)?.updated_at ?? item.ref.updatedAt,
          related: item.ref.related ?? [],
        };
        if (item.display.repeating) {
          const parent = await api.deleteEventOccurrenceChecked(
            id,
            item.state.occurrence.original_start_at,
            scope!,
            expected,
          );
          if (parent) plan.eventVersions.set(id, parent);
          const covered = plan.events.filter(
            (other) =>
              other.state.series.id === id &&
              (scope === "all" ||
                (scope === "following" &&
                  other.state.occurrence.original_start_at >=
                    item.state.occurrence.original_start_at) ||
                other.state.occurrence.original_start_at ===
                  item.state.occurrence.original_start_at),
          );
          remember(covered.map((entry) => entry.display.id));
        } else {
          if (!(await api.deleteEvent(id, expected))) throw changed();
          remember(
            plan.events
              .filter((other) => other.state.series.id === id)
              .map((other) => other.display.id),
          );
        }
      }
      for (const item of reminders) {
        if (plan.completed.has(item.display.id)) continue;
        if (!(await api.deleteReminder(item.state.reminder.id, item.state.reminder)))
          throw changed();
        remember(
          plan.reminders
            .filter((other) => other.state.reminder.id === item.state.reminder.id)
            .map((other) => other.display.id),
        );
      }
      return { message: `已删除 ${draft.selectedIds.length} 项${events.length ? "日程" : "提醒"}` };
    } catch (error) {
      if (error instanceof Error && /变化|不存在|已删除/.test(error.message)) throw changed();
      throw new Error("保存未完成，请重试。", { cause: error });
    }
  }
  async function prepareUpdate(
    kind: "event-update" | "reminder-update",
    raw: unknown,
    ctx: AiContext,
  ): Promise<Prepared<AiMutationDraft>> {
    try {
      const args =
        kind === "event-update"
          ? eventUpdateArgsSchema.parse(raw)
          : reminderUpdateArgsSchema.parse(raw);
      if (args.refs.length > 10) throw new MutationError("可能的目标太多，说得具体一点");
      const resolved = await resolveAll(
        args.refs,
        kind === "event-update" ? "event" : "reminder",
        ctx,
      );
      if (resolved.length > 1)
        return {
          type: "choose",
          candidates: resolved.map((item) => ({
            ...item.display,
            ...(item.display.repeating ? { detail: "重复项目" } : {}),
          })),
          prompt: "请选择要修改的项目",
          pick: async (id) =>
            args.refs.includes(id)
              ? prepareUpdate(kind, { ...args, refs: [id] }, ctx)
              : fail(missingRef()),
        };
      if (kind === "event-update") {
        const item = resolved[0] as EventItem;
        const changes = eventUpdateArgsSchema.parse(raw).changes;
        const initial: AiCreateDraft = {
          type: "event",
          form: occurrenceDraft(item.state.occurrence, item.state.series),
        };
        let form = structuredClone(initial.form);
        if (changes.all_day !== undefined && changes.all_day !== form.allDay)
          form = toggleAllDay(form, changes.all_day);
        if (changes.start !== undefined) {
          const oldStart = parseLocalTime(form.start, form.zone),
            oldEnd = parseLocalTime(form.end, form.zone);
          form.start = formatLocalTime(
            parseLocalTime(changes.start, ctx.timezone),
            form.zone,
            form.allDay,
          );
          if (changes.end === undefined)
            form.end = formatLocalTime(
              parseLocalTime(form.start, form.zone) + oldEnd - oldStart,
              form.zone,
              form.allDay,
            );
        }
        if (changes.end !== undefined)
          form.end = form.allDay
            ? shiftDay(changes.end, -1)
            : formatLocalTime(parseLocalTime(changes.end, ctx.timezone), form.zone);
        if (changes.title !== undefined) form.title = changes.title;
        if (changes.notes !== undefined) form.notes = changes.notes;
        if (changes.repeat !== undefined)
          form.repeat =
            changes.repeat === null
              ? { ...form.repeat, preset: "none" }
              : aiRepeatDraft(changes.repeat, parseLocalTime(form.start, form.zone), form.zone);
        if (changes.remind_before_minutes !== undefined)
          form.reminder = nearestAiReminder(changes.remind_before_minutes);
        const next: AiCreateDraft = { type: "event", form };
        const errors = validateAiCreateDraft(
          next,
          changes.end === undefined ? initial.form : undefined,
        );
        if (errors.length) throw new MutationError(errors[0]!);
        const note =
          changes.remind_before_minutes !== undefined &&
          changes.remind_before_minutes !== form.reminder
            ? `提前提醒已调整为 ${form.reminder ?? "不提醒"} 分钟，可在卡片中修改。`
            : undefined;
        return savePlan(kind, ctx, [item], [], initial, next, note);
      }
      const item = resolved[0] as ReminderItem;
      const changes = reminderUpdateArgsSchema.parse(raw).changes;
      const initial: AiCreateDraft = {
        type: "reminder",
        form: reminderForm(item.state.reminder, ctx.now),
      };
      const form = structuredClone(initial.form);
      if (changes.title !== undefined) form.title = changes.title;
      if (changes.notes !== undefined) form.notes = changes.notes;
      if (changes.priority !== undefined) form.priority = changes.priority;
      if (changes.due !== undefined) {
        form.timed = changes.due !== null;
        if (changes.due !== null)
          form.due = formatLocalTime(parseLocalTime(changes.due, ctx.timezone), form.zone);
        else form.repeat = { ...form.repeat, preset: "none" };
      }
      if (changes.repeat !== undefined) {
        if (changes.repeat !== null && !form.timed)
          throw new MutationError("重复提醒必须有到期时间");
        form.repeat =
          changes.repeat === null
            ? { ...form.repeat, preset: "none" }
            : aiRepeatDraft(changes.repeat, parseLocalTime(form.due, form.zone), form.zone);
      }
      const next: AiCreateDraft = { type: "reminder", form };
      parseAiCreateDraft(next);
      return savePlan(
        kind,
        ctx,
        [],
        [item],
        initial,
        next,
        item.display.repeating ? "将修改整个重复提醒，不区分仅这次。" : undefined,
      );
    } catch (error) {
      return fail(error);
    }
  }
  async function prepareDelete(
    kind: "event-delete" | "reminder-delete",
    raw: unknown,
    ctx: AiContext,
  ): Promise<Prepared<AiMutationDraft>> {
    try {
      const args = aiDeleteArgsSchema.parse(raw);
      if (args.mode === "pick_one" && args.refs.length > 10)
        throw new MutationError("可能的目标太多，说得具体一点");
      const items = await resolveAll(
        args.refs,
        kind === "event-delete" ? "event" : "reminder",
        ctx,
      );
      if (args.mode === "pick_one" && items.length > 1)
        return {
          type: "choose",
          candidates: items.map((item) => item.display),
          prompt: "请选择要删除的项目",
          pick: async (id) =>
            args.refs.includes(id)
              ? prepareDelete(kind, { refs: [id], mode: "pick_one" }, ctx)
              : fail(missingRef()),
        };
      return savePlan(
        kind,
        ctx,
        kind === "event-delete" ? (items as EventItem[]) : [],
        kind === "reminder-delete" ? (items as ReminderItem[]) : [],
      );
    } catch (error) {
      return fail(error);
    }
  }
  const base = (kind: AiMutationKind) => ({
    workbenchId: "com.royce.workbench.general",
    kind: "write" as const,
    requiresRead: true,
    Preview: AiMutationPreview,
    validate: (draft: AiMutationDraft) =>
      draft?.kind === kind ? validate(draft) : ["草稿类型与操作不一致"],
    execute: (draft: AiMutationDraft, scope?: SeriesScope) => {
      if (draft?.kind !== kind) return Promise.reject(new Error("草稿类型与操作不一致"));
      return execute(draft, scope)
        .then((result) => {
          plans.delete(draft.token);
          return result;
        })
        .catch((error: unknown) => {
          const plan = plans.get(draft.token);
          const done =
            plan?.original.items.filter(
              (item) =>
                plan.completed.has(item.id) && (plan.lockedSelection ?? []).includes(item.id),
            ).length ?? 0;
          if (done > 0)
            throw new Error(
              `已完成删除 ${done}/${plan?.lockedSelection?.length ?? done} 项。${error instanceof Error ? error.message : "保存未完成"} 重试只处理剩余项目，请保持原选择及范围。`,
              { cause: error },
            );
          throw error;
        });
    },
  });
  const event: AiActionDefinition<z.infer<typeof eventUpdateArgsSchema>, AiMutationDraft> = {
    ...base("event-update"),
    name: "calendar_update_event",
    description:
      "用真实读取ref生成日程修改差异卡片。多个目标时由用户选择；重复日程必须由用户选择范围。start改动且没有end时保持原时长；修改时间后日程最长7天。全天end是不含结束当天边界。",
    args: eventUpdateArgsSchema,
    parameters: parameters({
      title: { type: "string", minLength: 1 },
      notes: { type: "string" },
      start: whenParameter,
      end: whenParameter,
      all_day: { type: "boolean" },
      repeat: repeatParameter,
      remind_before_minutes: { type: ["integer", "null"], minimum: 0 },
    }),
    prepare: (raw, ctx) => prepareUpdate("event-update", raw, ctx),
  };
  const reminder: AiActionDefinition<z.infer<typeof reminderUpdateArgsSchema>, AiMutationDraft> = {
    ...base("reminder-update"),
    name: "reminders_update",
    description:
      "用真实读取ref生成提醒修改差异卡片。重复提醒修改整个规则；日程生成和金融提醒禁止改动。",
    args: reminderUpdateArgsSchema,
    parameters: parameters({
      title: { type: "string", minLength: 1 },
      notes: { type: "string" },
      due: { anyOf: [whenParameter, { type: "null" }] },
      repeat: repeatParameter,
      priority: { type: "integer", minimum: 0, maximum: 3 },
    }),
    prepare: (raw, ctx) => prepareUpdate("reminder-update", raw, ctx),
  };
  const deletion = (
    kind: "event-delete" | "reminder-delete",
  ): AiActionDefinition<z.infer<typeof aiDeleteArgsSchema>, AiMutationDraft> => ({
    ...base(kind),
    name: kind === "event-delete" ? "calendar_delete_event" : "reminders_delete",
    description:
      "只能用真实读取ref提出删除。pick_one让用户选一个，all_listed逐条勾选至多20项；日程生成和金融提醒禁止删除。",
    args: aiDeleteArgsSchema,
    parameters: parameters(),
    prepare: (raw, ctx) => prepareDelete(kind, raw, ctx),
    select: (draft, ids) => ({ ...draft, selectedIds: [...ids] }),
  });
  return [event, reminder, deletion("event-delete"), deletion("reminder-delete")];
}
