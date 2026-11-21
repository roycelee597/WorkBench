import { z } from "zod";
import type {
  AiActionDefinition,
  AiActionGroup,
  AiContext,
  JsonSchemaObject,
  Prepared,
} from "../../../apps/desktop/src/core/ai/action-types";
import { formatLocalTime, parseLocalTime } from "../../../apps/desktop/src/core/ai/local-time";
import { generalApi, normalizeTags, type GeneralApi } from "./api";
import { draftFields, shiftDay } from "./calendar-model";
import { reminderFields } from "./reminder-model";
import { AiCreatePreview } from "./components/AiCreatePreview";
import { createAiReadActions } from "./ai-read-actions";
import { createAiMutationActions } from "./ai-mutation-actions";
import {
  aiRepeatDraft,
  defaultAiEventColor,
  eventCreateArgsSchema,
  MAX_AI_EVENT_DURATION_MINUTES,
  memoCreateArgsSchema,
  nearestAiReminder,
  parseAiCreateDraft,
  reminderCreateArgsSchema,
  validateAiCreateDraft,
  type AiCreateDraft,
} from "./ai-create-model";

const GENERAL_WORKBENCH = "com.royce.workbench.general";
const AI_SOURCE = "com.royce.workbench.ai";
const dateParameter = {
  type: "string",
  description: "严格本地日期 YYYY-MM-DD 或时间 YYYY-MM-DDTHH:mm，不含时区偏移",
  pattern: "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2})?$",
};
const repeatParameter = {
  type: "object",
  additionalProperties: false,
  properties: {
    preset: { type: "string", enum: ["daily", "workdays", "weekly", "monthly", "yearly"] },
    weekdays: {
      type: "array",
      description: "只用于 weekly，1=周一至7=周日；不填沿用开始日期的星期",
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
};
const stringParameter = { type: "string" };
function parameters(properties: Record<string, unknown>, required: string[]): JsonSchemaObject {
  return { type: "object", properties, required, additionalProperties: false };
}
function failure(error: unknown): Prepared<AiCreateDraft> {
  return {
    type: "error",
    message:
      error instanceof z.ZodError
        ? "AI 返回的新建参数无效，请换个说法或手动新建"
        : error instanceof Error
          ? error.message
          : "新建草稿无效，请手动新建",
    fallback: "manual",
  };
}
function validateType(type: AiCreateDraft["type"], value: unknown): string[] {
  const errors = validateAiCreateDraft(value);
  if (errors.length) return errors;
  return parseAiCreateDraft(value).type === type ? [] : ["草稿类型与操作不一致"];
}
function checked(type: AiCreateDraft["type"], value: unknown): AiCreateDraft {
  const errors = validateType(type, value);
  if (errors.length) throw new Error(errors[0]);
  return parseAiCreateDraft(value);
}
function pastNote(stamp: number, ctx: AiContext): string | undefined {
  return stamp < ctx.now ? "时间已在过去，请确认日期和时间是否正确。" : undefined;
}

export function createGeneralAiActions(api: GeneralApi = generalApi): AiActionGroup {
  const event: AiActionDefinition<z.infer<typeof eventCreateArgsSchema>, AiCreateDraft> = {
    name: "calendar_create_event",
    workbenchId: GENERAL_WORKBENCH,
    kind: "write",
    description:
      "生成待确认的新建日程。没有结束时间默认1小时；全天默认当天。end必须晚于start，日程最长7天，全天end为不含结束当天的日期边界；end优先于duration_minutes。提前提醒未给时用用户设置，非标准值向下取最近档。",
    args: eventCreateArgsSchema,
    parameters: parameters(
      {
        title: { ...stringParameter, minLength: 1 },
        notes: stringParameter,
        start: dateParameter,
        end: {
          ...dateParameter,
          description:
            "必须晚于start；全天时为不含结束当天的日期边界，例如11月18日全天的end填11月19日",
        },
        duration_minutes: { type: "integer", minimum: 1, maximum: MAX_AI_EVENT_DURATION_MINUTES },
        all_day: { type: "boolean" },
        repeat: repeatParameter,
        remind_before_minutes: {
          type: ["integer", "null"],
          minimum: 0,
          description: "null为不提醒；推荐0/5/10/15/30/60/1440，其他非负值向下取档",
        },
      },
      ["title", "start"],
    ),
    async prepare(value, ctx) {
      try {
        const args = eventCreateArgsSchema.parse(value);
        const stamp = parseLocalTime(args.start, ctx.timezone);
        if (args.end) parseLocalTime(args.end, ctx.timezone);
        const allDay = args.all_day ?? args.start.length === 10;
        if (allDay && (args.start.length !== 10 || (args.end && args.end.length !== 10)))
          throw new Error("全天日程起止请只填写日期");
        if (args.end && parseLocalTime(args.end, ctx.timezone) <= stamp)
          throw new Error("结束时间必须晚于开始时间");
        const start = allDay ? args.start.slice(0, 10) : formatLocalTime(stamp, ctx.timezone);
        const end = args.end
          ? allDay
            ? shiftDay(args.end, -1)
            : formatLocalTime(parseLocalTime(args.end, ctx.timezone), ctx.timezone)
          : allDay
            ? start
            : formatLocalTime(stamp + (args.duration_minutes ?? 60) * 60_000, ctx.timezone);
        const reminder =
          args.remind_before_minutes === undefined
            ? await api.getDefaultEventReminder()
            : nearestAiReminder(args.remind_before_minutes);
        const draft: AiCreateDraft = {
          type: "event",
          form: {
            title: args.title,
            notes: args.notes ?? "",
            start,
            end,
            allDay,
            zone: ctx.timezone,
            color: defaultAiEventColor,
            reminder,
            repeat: aiRepeatDraft(args.repeat, parseLocalTime(start, ctx.timezone), ctx.timezone),
          },
        };
        parseAiCreateDraft(draft);
        const notes = [pastNote(parseLocalTime(start, ctx.timezone), ctx)];
        if (args.remind_before_minutes !== undefined && args.remind_before_minutes !== reminder)
          notes.push(
            `提前提醒已从 ${args.remind_before_minutes} 分钟调整为 ${reminder} 分钟（不超过原值的最近一档），可在卡片中修改。`,
          );
        return {
          type: "proposal",
          draft,
          ...(notes.some(Boolean) ? { note: notes.filter(Boolean).join(" ") } : {}),
        };
      } catch (error) {
        return failure(error);
      }
    },
    Preview: AiCreatePreview,
    validate: (draft) => validateType("event", draft),
    async execute(value) {
      const draft = checked("event", value);
      if (draft.type !== "event") throw new Error("草稿类型不一致");
      const record = await api.createEvent({
        ...draftFields(draft.form),
        source_workbench: AI_SOURCE,
      });
      return {
        message: "已新建日程",
        target: { kind: "event", eventId: record.id, originalStart: null },
      };
    },
  };
  const reminder: AiActionDefinition<z.infer<typeof reminderCreateArgsSchema>, AiCreateDraft> = {
    name: "reminders_create",
    workbenchId: GENERAL_WORKBENCH,
    kind: "write",
    description:
      "生成待确认的新建提醒。due为null表示无时间待办；重复提醒必须给出due；priority为0无、1低、2中、3高。",
    args: reminderCreateArgsSchema,
    parameters: parameters(
      {
        title: { ...stringParameter, minLength: 1 },
        notes: stringParameter,
        due: { anyOf: [dateParameter, { type: "null" }] },
        repeat: repeatParameter,
        priority: { type: "integer", minimum: 0, maximum: 3 },
      },
      ["title", "due"],
    ),
    async prepare(value, ctx) {
      try {
        const args = reminderCreateArgsSchema.parse(value);
        if (args.repeat && args.due === null) throw new Error("重复提醒必须有到期时间");
        const stamp =
          args.due === null ? ctx.now + 3_600_000 : parseLocalTime(args.due, ctx.timezone);
        const draft: AiCreateDraft = {
          type: "reminder",
          form: {
            title: args.title,
            notes: args.notes ?? "",
            timed: args.due !== null,
            due: formatLocalTime(stamp, ctx.timezone),
            zone: ctx.timezone,
            priority: args.priority ?? 0,
            repeat: aiRepeatDraft(args.repeat, stamp, ctx.timezone),
          },
        };
        parseAiCreateDraft(draft);
        const note = args.due === null ? undefined : pastNote(stamp, ctx);
        return { type: "proposal", draft, ...(note ? { note } : {}) };
      } catch (error) {
        return failure(error);
      }
    },
    Preview: AiCreatePreview,
    validate: (draft) => validateType("reminder", draft),
    async execute(value) {
      const draft = checked("reminder", value);
      if (draft.type !== "reminder") throw new Error("草稿类型不一致");
      const record = await api.createReminder({
        ...reminderFields(draft.form),
        source_workbench: AI_SOURCE,
        source: "manual",
      });
      return {
        message: "已新建提醒",
        target: { kind: "reminder", reminderId: record.id, occurrenceId: null },
      };
    },
  };
  const memo: AiActionDefinition<z.infer<typeof memoCreateArgsSchema>, AiCreateDraft> = {
    name: "memos_create",
    workbenchId: GENERAL_WORKBENCH,
    kind: "write",
    description:
      "生成待确认的新建备忘录，正文只能来自用户这句话的内容，不读取已有备忘录。可提供标题和标签。",
    args: memoCreateArgsSchema,
    parameters: parameters(
      {
        title: stringParameter,
        content: { ...stringParameter, minLength: 1 },
        tags: { type: "array", items: stringParameter },
      },
      ["content"],
    ),
    async prepare(value) {
      try {
        const args = memoCreateArgsSchema.parse(value);
        const draft: AiCreateDraft = {
          type: "memo",
          form: {
            title: args.title?.trim() ?? "",
            content: args.content,
            pinned: false,
            tags: normalizeTags(args.tags ?? []),
          },
        };
        parseAiCreateDraft(draft);
        return { type: "proposal", draft };
      } catch (error) {
        return failure(error);
      }
    },
    Preview: AiCreatePreview,
    validate: (draft) => validateType("memo", draft),
    async execute(value) {
      const draft = checked("memo", value);
      if (draft.type !== "memo") throw new Error("草稿类型不一致");
      const record = await api.createMemoWith(draft.form);
      return { message: "已新建备忘录", target: { kind: "memo", memoId: record.id } };
    },
  };
  return { workbenchId: GENERAL_WORKBENCH, label: "综合工作台", actions: [event, reminder, memo] };
}

const creates = createGeneralAiActions();
export const generalAiActions: AiActionGroup = {
  ...creates,
  actions: [
    ...creates.actions,
    ...createAiReadActions(generalApi),
    ...createAiMutationActions(generalApi),
  ],
};
