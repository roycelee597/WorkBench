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
  ResultItem,
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
  eventDeleteIntent,
  eventTimeIntent,
  linkedReminderIntent,
  localTimeChange,
  mutationDateSelector,
} from "./ai-mutation-intent";
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
  .max(20);
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
const missingDay = () => new MutationError("没有找到符合所指定日期的项目，请重新确认日期");
const linkedReminder = (target?: AiTarget) =>
  new MutationError("这条提醒由日程生成，请修改对应日程", target);
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
        description: "使用读取结果中的真实短引用；同一目标不要重复，重复日程按实例区分",
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

function targetKey(target: AiTarget): string {
  switch (target.kind) {
    case "event":
      return JSON.stringify([target.eventId, target.originalStart]);
    case "reminder":
      return target.reminderId;
    case "memo":
      return target.memoId;
  }
}

function distinctTargets<T extends { target: AiTarget }>(items: readonly T[]): T[] {
  const targets = new Map<string, T>();
  for (const item of items) {
    const key = targetKey(item.target);
    if (!targets.has(key)) targets.set(key, item);
  }
  return [...targets.values()];
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
  function requireWritableReminder(item: ReminderItem): void {
    if (item.state.reminder.source === "event") throw linkedReminder(item.state.linkedTarget);
    if (isFinanceReminder(item.state.reminder))
      throw new MutationError("金融提醒只能查询，不能通过 AI 修改或删除");
  }
  async function resolveAll(refs: string[], kind: "event" | "reminder", ctx: AiContext) {
    // 先检查全部 ref，再读取全部目标；任何一项无效都不生成候选或部分卡片。
    const distinct = [...new Set(refs)];
    for (const ref of distinct) reference(ref, kind, ctx);
    return kind === "event"
      ? Promise.all(distinct.map((ref) => eventItem(ref, ctx)))
      : Promise.all(distinct.map((ref) => reminderItem(ref, ctx)));
  }
  async function exactSeriesDay(items: EventItem[], day: string, ctx: AiContext) {
    const anchor = items[0];
    if (
      !anchor?.state.series.rrule ||
      !items.every((item) => item.state.series.id === anchor.state.series.id)
    )
      return;
    const { occurrences } = await api.loadCalendar({
      start: parseLocalTime(day, ctx.timezone),
      end: parseLocalTime(shiftDay(day, 1), ctx.timezone),
    });
    const matching = occurrences.filter(
      (item) =>
        item.series_id === anchor.state.series.id &&
        formatLocalTime(item.start_at, ctx.timezone, true) === day,
    );
    if (matching.length !== 1) return;
    const occurrence = matching[0]!;
    const target: AiTarget = {
      kind: "event",
      eventId: anchor.state.series.id,
      originalStart: occurrence.original_start_at,
    };
    const resolved: RefEntry = {
      ...anchor.ref,
      target,
      related: occurrence.is_exception
        ? [{ id: occurrence.event.id, updatedAt: occurrence.event.updated_at }]
        : [],
    };
    // 补查结果仅在本卡片内使用。沿用初始短引用的有效期、撤销和父日程版本。
    const localContext: AiContext = {
      ...ctx,
      refs: {
        issue: ctx.refs.issue.bind(ctx.refs),
        clear: ctx.refs.clear.bind(ctx.refs),
        resolve(ref, kind) {
          const live = ctx.refs.resolve(ref, kind);
          return live && ref === anchor.ref.ref && kind === "event" ? resolved : live;
        },
      },
    };
    return { item: await eventItem(anchor.ref.ref, localContext), ctx: localContext };
  }
  async function resolveCandidates(refs: string[], kind: "event" | "reminder", ctx: AiContext) {
    const resolved = await resolveAll(refs, kind, ctx);
    const dates = mutationDateSelector(ctx);
    const candidates = resolved.filter((item) =>
      dates.matches(
        "series" in item.state
          ? item.state.occurrence.start_at
          : (item.state.occurrence?.due_at ?? item.state.reminder.due_at),
      ),
    );
    if (!candidates.length) {
      if (kind === "event" && dates.exactDay) {
        const exact = await exactSeriesDay(resolved as EventItem[], dates.exactDay, ctx);
        if (exact) return { items: [exact.item], ctx: exact.ctx };
      }
      throw missingDay();
    }
    const targets = distinctTargets(candidates.map((item) => item.display));
    const ids = new Set(targets.map((target) => target.id));
    return { items: candidates.filter((item) => ids.has(item.display.id)), ctx };
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
      requireWritableReminder(fresh);
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
    picked = false,
  ): Promise<Prepared<AiMutationDraft>> {
    try {
      const args =
        kind === "event-update"
          ? eventUpdateArgsSchema.parse(raw)
          : reminderUpdateArgsSchema.parse(raw);
      const targetKind = kind === "event-update" ? "event" : "reminder";
      for (const ref of args.refs) reference(ref, targetKind, ctx);
      if (linkedReminderIntent(ctx.userText ?? "")) {
        const callerItems = await resolveAll(args.refs, targetKind, ctx);
        const items: ResultItem[] = callerItems.map((item) => ({
          ...item.display,
          badges:
            "series" in item.state
              ? item.state.occurrence.event.remind_before_minutes !== null
                ? ["remind"]
                : []
              : item.state.reminder.source === "event"
                ? ["event-linked"]
                : [],
        }));
        return (await recoverLinkedReminder([...(ctx.readItems ?? []), ...items], ctx))!;
      }
      const intent = kind === "event-update" ? eventTimeIntent(ctx.userText ?? "") : undefined;
      const refs = new Set(args.refs);
      if (!picked && intent && mutationDateSelector(ctx).constrained) {
        const matching = readCandidates(ctx.readItems ?? [], "event", intent.title, ctx);
        if (matching.some((item) => refs.has(item.id)))
          for (const item of matching) refs.add(item.id);
      }
      const { items: resolved, ctx: localContext } = await resolveCandidates(
        [...refs],
        targetKind,
        ctx,
      );
      if (resolved.length > 10) throw new MutationError("可能的目标太多，说得具体一点");
      if (kind === "reminder-update") (resolved as ReminderItem[]).forEach(requireWritableReminder);
      if (resolved.length > 1)
        return {
          type: "choose",
          candidates: resolved.map((item) => ({
            ...item.display,
            ...(item.display.repeating ? { detail: "重复项目" } : {}),
          })),
          prompt: "请选择要修改的项目",
          pick: async (id) =>
            resolved.some((item) => item.display.id === id)
              ? prepareUpdate(kind, { ...args, refs: [id] }, localContext, true)
              : fail(missingRef()),
        };
      if (kind === "event-update") {
        const item = resolved[0] as EventItem;
        const dates = mutationDateSelector(localContext);
        const changes =
          intent && item.display.title.includes(intent.title)
            ? {
                start: localTimeChange(item.state.occurrence.start_at, ctx.timezone, intent.timing),
              }
            : eventUpdateArgsSchema.parse(raw).changes;
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
        const notes: string[] = [];
        if (
          changes.remind_before_minutes !== undefined &&
          changes.remind_before_minutes !== form.reminder
        )
          notes.push(`提前提醒已调整为 ${form.reminder ?? "不提醒"} 分钟，可在卡片中修改。`);
        if (dates.following && item.display.repeating)
          notes.push("如需从这个实例起修改，请选择「这次及以后」。");
        return savePlan(
          kind,
          localContext,
          [item],
          [],
          initial,
          next,
          notes.join(" ") || undefined,
        );
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
        localContext,
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
      const { items, ctx: localContext } = await resolveCandidates(
        args.refs,
        kind === "event-delete" ? "event" : "reminder",
        ctx,
      );
      if (kind === "reminder-delete") (items as ReminderItem[]).forEach(requireWritableReminder);
      const pickOne =
        args.mode === "pick_one" ||
        (kind === "event-delete" &&
          mutationDateSelector(ctx).constrained &&
          eventDeleteIntent(ctx.userText ?? "") !== undefined);
      if (pickOne && items.length > 10) throw new MutationError("可能的目标太多，说得具体一点");
      if (pickOne && items.length > 1)
        return {
          type: "choose",
          candidates: items.map((item) => item.display),
          prompt: "请选择要删除的项目",
          pick: async (id) =>
            items.some((item) => item.display.id === id)
              ? prepareDelete(kind, { refs: [id], mode: "pick_one" }, localContext)
              : fail(missingRef()),
        };
      return savePlan(
        kind,
        localContext,
        kind === "event-delete" ? (items as EventItem[]) : [],
        kind === "reminder-delete" ? (items as ReminderItem[]) : [],
      );
    } catch (error) {
      return fail(error);
    }
  }
  function readCandidates(
    items: readonly ResultItem[],
    kind: "event" | "reminder",
    title: string,
    ctx: AiContext,
  ): ResultItem[] {
    return items.filter(
      (item) =>
        item.target.kind === kind &&
        item.title.includes(title) &&
        ctx.refs.resolve(item.id, kind) !== null,
    );
  }
  async function recoverEventTime(
    items: readonly ResultItem[],
    ctx: AiContext,
  ): Promise<Prepared<AiMutationDraft> | undefined> {
    const intent = eventTimeIntent(ctx.userText ?? "");
    if (!intent || /提醒|备忘录/u.test(intent.title)) return;
    const refs = readCandidates(items, "event", intent.title, ctx).map((item) => item.id);
    if (!refs.length) return;
    try {
      const { items, ctx: localContext } = await resolveCandidates(refs, "event", ctx);
      const events = items as EventItem[];
      const prepare = (item: EventItem) =>
        prepareUpdate(
          "event-update",
          {
            refs: [item.display.id],
            changes: {
              start: localTimeChange(item.state.occurrence.start_at, ctx.timezone, intent.timing),
            },
          },
          localContext,
          true,
        );
      if (events.length > 10) throw new MutationError("可能的目标太多，说得具体一点");
      if (events.length === 1) return prepare(events[0]!);
      return {
        type: "choose",
        candidates: events.map((item) => item.display),
        prompt: "请选择要修改的项目",
        pick: async (id) => {
          const item = events.find((entry) => entry.display.id === id);
          return item ? prepare(item) : fail(missingRef());
        },
      };
    } catch (error) {
      return fail(error);
    }
  }
  async function recoverLinkedReminder(
    items: readonly ResultItem[],
    ctx: AiContext,
  ): Promise<Prepared<AiMutationDraft> | undefined> {
    const title = linkedReminderIntent(ctx.userText ?? "");
    if (!title) return;
    const reminders = distinctTargets(
      readCandidates(items, "reminder", title, ctx).filter((item) =>
        item.badges.includes("event-linked"),
      ),
    );
    const events = distinctTargets(
      readCandidates(items, "event", title, ctx).filter((item) => item.badges.includes("remind")),
    );
    try {
      // 关联、目标实例与并发快照以综合工作台当下的记录为准。
      if (reminders.length === 1) {
        const item = await reminderItem(reminders[0]!.id, ctx);
        if (item.state.reminder.source === "event")
          return fail(linkedReminder(item.state.linkedTarget));
      }
      if (events.length === 1) {
        const item = await eventItem(events[0]!.id, ctx);
        if (item.state.occurrence.event.remind_before_minutes !== null)
          return fail(linkedReminder(item.ref.target));
      }
      if (items.length === 0) {
        // 即使上游没有发起读取，明确点名的关联提醒仍可在本地核对。这里不发短引用。
        const dates = mutationDateSelector(ctx);
        const matches = (await api.listReminders()).filter(
          (item) =>
            item.isCurrent &&
            item.reminder.source === "event" &&
            item.title === title &&
            dates.matches(item.due_at),
        );
        if (matches.length === 1) {
          const { reminder, occurrenceId } = matches[0]!;
          const state = await api.aiReminderState(reminder.id, occurrenceId);
          if (state.reminder.updated_at !== reminder.updated_at) throw changed();
          if (state.reminder.source === "event") return fail(linkedReminder(state.linkedTarget));
        }
      }
      return fail(linkedReminder());
    } catch (error) {
      return fail(error);
    }
  }
  async function recoverEventDelete(
    items: readonly ResultItem[],
    ctx: AiContext,
  ): Promise<Prepared<AiMutationDraft> | undefined> {
    const title = eventDeleteIntent(ctx.userText ?? "");
    if (!title || !mutationDateSelector(ctx).constrained) return;
    const refs = readCandidates(items, "event", title, ctx).map((item) => item.id);
    if (!refs.length) return;
    return prepareDelete("event-delete", { refs, mode: "pick_one" }, ctx);
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
      "必须调用本工具生成日程修改卡，不用文字模拟卡片或追问已查到的候选。按用户指定的日期、星期筛选后传入全部匹配的真实ref。说「从某天开始」时传入当天的重复实例，由用户选择范围。start改动且没有end时保留时长；日程最长7天。全天end是不含结束当天边界。",
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
    recoverFromRead: recoverEventTime,
  };
  const reminder: AiActionDefinition<z.infer<typeof reminderUpdateArgsSchema>, AiMutationDraft> = {
    ...base("reminder-update"),
    name: "reminders_update",
    description:
      "必须调用本工具生成提醒修改卡或本地拒绝，按用户指定日期筛选后传入全部匹配的真实ref。重复提醒修改整个规则；发现日程生成的提醒仍传入它的ref，由本地拒绝并提供原日程跳转。金融提醒禁止改动。",
    args: reminderUpdateArgsSchema,
    parameters: parameters({
      title: { type: "string", minLength: 1 },
      notes: { type: "string" },
      due: { anyOf: [whenParameter, { type: "null" }] },
      repeat: repeatParameter,
      priority: { type: "integer", minimum: 0, maximum: 3 },
    }),
    prepare: (raw, ctx) => prepareUpdate("reminder-update", raw, ctx),
    recoverFromRead: recoverLinkedReminder,
  };
  const deletion = (
    kind: "event-delete" | "reminder-delete",
  ): AiActionDefinition<z.infer<typeof aiDeleteArgsSchema>, AiMutationDraft> => ({
    ...base(kind),
    name: kind === "event-delete" ? "calendar_delete_event" : "reminders_delete",
    description:
      "必须调用本工具提出删除。按用户指定的日期、星期筛选后传入全部匹配的真实ref。pick_one用卡片选择，不用文字追问；用户明确要求批量才用all_listed，逐条勾选至多20项。日程生成和金融提醒禁止删除。",
    args: aiDeleteArgsSchema,
    parameters: parameters(),
    prepare: (raw, ctx) => prepareDelete(kind, raw, ctx),
    ...(kind === "event-delete" ? { recoverFromRead: recoverEventDelete } : {}),
    select: (draft, ids) => ({ ...draft, selectedIds: [...ids] }),
  });
  return [event, reminder, deletion("event-delete"), deletion("reminder-delete")];
}
