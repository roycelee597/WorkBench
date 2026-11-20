import { z } from "zod";
import {
  DATA_NOTICE,
  type AiActionDefinition,
  type AiActionGroup,
  type AiContext,
  type AiTarget,
  type DataPayload,
  type Prepared,
  type RefTable,
  type ResultItem,
} from "../../../apps/desktop/src/core/ai/action-types";
import {
  MAX_READ_CHARS,
  MAX_READ_DAYS,
  MAX_READ_ITEMS,
} from "../../../apps/desktop/src/core/ai/limits";
import { formatLocalTime, parseLocalTime } from "../../../apps/desktop/src/core/ai/local-time";
import { parseRule } from "../../../apps/desktop/src/core/calendar/recurrence";
import { isFinanceReminder, type CalendarEvent, type GeneralApi, type ReminderItem } from "./api";
import { aiRepeatSummary } from "./ai-create-model";
import { readRepeat, shiftDay } from "./calendar-model";

const when = z.string().refine((value) => {
  try {
    parseLocalTime(value, "UTC");
    return true;
  } catch {
    return false;
  }
}, "日期或时间无效");
const eventsArgs = z.object({ from: when, to: when, keyword: z.string().optional() }).strict();
const remindersArgs = z
  .object({
    keyword: z.string().optional(),
    due_from: when.optional(),
    due_to: when.optional(),
    status: z.enum(["open", "completed", "all"]).optional(),
  })
  .strict();
const dateParameter = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2})?$",
  description: "当地日期或分钟时间；范围左含右不含，最多366当地自然日",
};
const GENERAL_WORKBENCH = "com.royce.workbench.general";
type Plan = {
  target: AiTarget;
  snapshot: Parameters<RefTable["issue"]>[1];
  fields: DataPayload["items"][number];
  result: Omit<ResultItem, "id">;
};
type Range = { start: number; end: number; clipped: boolean };
const fold = (value: string) => value.toLocaleLowerCase("zh-CN");
const matches = (title: string, keyword: string | undefined) =>
  !keyword?.trim() || fold(title).includes(fold(keyword.trim()));
const shortTitle = (title: string) => {
  const points = Array.from(title);
  return points.length > 60 ? `${points.slice(0, 59).join("")}…` : title;
};
function shiftLocal(timestamp: number, days: number, zone: string): number {
  const local = formatLocalTime(timestamp, zone);
  return parseLocalTime(`${shiftDay(local, days)}${local.slice(10)}`, zone);
}
function range(from: string, to: string, zone: string): Range {
  const start = parseLocalTime(from, zone);
  const requestedEnd = parseLocalTime(to, zone);
  if (requestedEnd <= start) throw new Error("查询结束时间必须晚于开始时间");
  const end = Math.min(requestedEnd, shiftLocal(start, MAX_READ_DAYS, zone));
  return { start, end, clipped: end !== requestedEnd };
}
function reminderRange(args: z.infer<typeof remindersArgs>, ctx: AiContext): Range {
  const zone = ctx.timezone;
  if (args.due_from && args.due_to) return range(args.due_from, args.due_to, zone);
  if (args.due_from) {
    const start = parseLocalTime(args.due_from, zone);
    return { start, end: shiftLocal(start, MAX_READ_DAYS, zone), clipped: false };
  }
  if (args.due_to) {
    const end = parseLocalTime(args.due_to, zone);
    return { start: shiftLocal(end, -MAX_READ_DAYS, zone), end, clipped: false };
  }
  const today = formatLocalTime(ctx.now, zone, true);
  const start = parseLocalTime(shiftDay(today, -MAX_READ_DAYS / 2), zone);
  return { start, end: shiftLocal(start, MAX_READ_DAYS, zone), clipped: false };
}
function friendlyRepeat(rule: string | null, start: number, zone: string): string | null {
  if (!rule) return null;
  try {
    const draft = readRepeat(rule, start, zone);
    let result = aiRepeatSummary(draft);
    const interval = parseRule(rule).interval ?? 1;
    if (interval !== 1) {
      const prefix =
        draft.preset === "daily"
          ? `每${interval}天`
          : draft.preset === "monthly"
            ? `每${interval}个月（按日期）`
            : draft.preset === "yearly"
              ? `每${interval}年`
              : `每${interval}周（${result.split("，")[0]}）`;
      result =
        prefix + result.slice(result.indexOf("，") < 0 ? result.length : result.indexOf("，"));
    }
    return result;
  } catch {
    return "自定义重复（请在工作台查看规则）";
  }
}
function localWhen(stamp: number, zone: string, dateOnly = false): string {
  const local = formatLocalTime(stamp, zone, dateOnly);
  const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: zone }).format(
    stamp,
  );
  return `${local.slice(0, 10)} ${weekday}${dateOnly ? "" : ` ${local.slice(11)}`}`;
}
function eventWhen(start: number, end: number, allDay: boolean, zone: string): string {
  if (allDay) {
    const first = formatLocalTime(start, zone, true);
    const last = shiftDay(formatLocalTime(end, zone, true), -1);
    return `${localWhen(start, zone, true)}${last === first ? "" : ` — ${localWhen(parseLocalTime(last, zone), zone, true)}`} 全天`;
  }
  return `${localWhen(start, zone)} — ${localWhen(end, zone)}`;
}
function modelData(
  plans: Plan[],
  appliedRange: DataPayload["range"],
  clipped: boolean,
  ctx: AiContext,
): Prepared<never> {
  const base = {
    type: "workbench_data" as const,
    notice: DATA_NOTICE,
    range: appliedRange,
    total: plans.length,
  };
  const chosen: Plan[] = [];
  const estimated: DataPayload["items"] = [];
  // 用最大安全整数长度保守预算；裁剪完才发引用，避免未发送条目也能被引用。
  for (const plan of plans.slice(0, MAX_READ_ITEMS)) {
    const ref = plan.target.kind === "event" ? "e9007199254740991" : "r9007199254740991";
    const item = { ref, ...plan.fields };
    if (
      JSON.stringify({ ...base, truncated: false, items: [...estimated, item] }).length >
      MAX_READ_CHARS
    )
      break;
    chosen.push(plan);
    estimated.push(item);
  }
  const payload: DataPayload = {
    ...base,
    truncated: clipped || chosen.length < plans.length,
    items: [],
  };
  const items: ResultItem[] = [];
  for (const plan of chosen) {
    const ref = ctx.refs.issue(plan.target, plan.snapshot);
    payload.items.push({ ref, ...plan.fields });
    items.push({ id: ref, ...plan.result });
  }
  return { type: "data", payload, items };
}
const failed = (error: unknown): Prepared<never> => ({
  type: "error",
  message:
    error instanceof z.ZodError
      ? "读取参数无效，请检查日期范围"
      : error instanceof Error
        ? error.message
        : "读取失败，请手动查看工作台",
  fallback: "manual",
});
function eventBadges(event: CalendarEvent, repeating: boolean): ResultItem["badges"] {
  return [
    ...(repeating ? ["repeat" as const] : []),
    ...(event.remind_before_minutes !== null ? ["remind" as const] : []),
    ...(event.source_workbench === "com.royce.workbench.finance" ? ["finance" as const] : []),
  ];
}
function reminderBadges(item: ReminderItem): ResultItem["badges"] {
  return [
    ...(item.reminder.rrule ? ["repeat" as const] : []),
    ...(item.completed_at !== null ? ["completed" as const] : []),
    ...(item.reminder.source === "event" ? ["event-linked" as const] : []),
    ...(isFinanceReminder(item.reminder) ? ["finance" as const] : []),
  ];
}

export function createAiReadActions(api: GeneralApi): AiActionGroup["actions"] {
  const events: AiActionDefinition<z.infer<typeof eventsArgs>, unknown> = {
    name: "calendar_list_events",
    workbenchId: GENERAL_WORKBENCH,
    kind: "read",
    description:
      "只读查询日程实例，按开始时间排序；from含、to不含，最多366当地自然日。关键词只匹配标题。返回短ref和限定字段，超过500条或30000字符会截断并标明总数。",
    args: eventsArgs,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["from", "to"],
      properties: { from: dateParameter, to: dateParameter, keyword: { type: "string" } },
    },
    async prepare(value, ctx) {
      try {
        const args = eventsArgs.parse(value);
        const applied = range(args.from, args.to, ctx.timezone);
        const { events, occurrences } = await api.loadCalendar({
          start: applied.start,
          end: applied.end,
        });
        const parents = new Map(events.map((event) => [event.id, event]));
        const plans = occurrences
          .filter((occurrence) => matches(occurrence.event.title, args.keyword))
          .map((occurrence): Plan => {
            const series = parents.get(occurrence.series_id);
            if (!series) throw new Error("日程系列已不存在，请重新查询");
            const event = occurrence.event;
            const target: AiTarget = {
              kind: "event",
              eventId: series.id,
              originalStart: series.rrule ? occurrence.original_start_at : null,
            };
            return {
              target,
              snapshot: {
                updatedAt: series.updated_at,
                ...(occurrence.is_exception
                  ? { related: [{ id: event.id, updatedAt: event.updated_at }] }
                  : {}),
              },
              fields: {
                title: shortTitle(event.title),
                start: formatLocalTime(occurrence.start_at, ctx.timezone, event.all_day),
                end: formatLocalTime(occurrence.end_at, ctx.timezone, event.all_day),
                all_day: event.all_day,
                repeat: friendlyRepeat(series.rrule, series.start_at, series.timezone),
                remind:
                  event.remind_before_minutes === null
                    ? null
                    : event.remind_before_minutes === 0
                      ? "准时"
                      : `提前${event.remind_before_minutes}分钟`,
              },
              result: {
                target,
                title: event.title,
                when: eventWhen(
                  occurrence.start_at,
                  occurrence.end_at,
                  event.all_day,
                  ctx.timezone,
                ),
                badges: eventBadges(event, series.rrule !== null),
              },
            };
          });
        return modelData(
          plans,
          {
            from: formatLocalTime(applied.start, ctx.timezone),
            to: formatLocalTime(applied.end, ctx.timezone),
          },
          applied.clipped,
          ctx,
        );
      } catch (error) {
        return failed(error);
      }
    },
  };
  const reminders: AiActionDefinition<z.infer<typeof remindersArgs>, unknown> = {
    name: "reminders_list",
    workbenchId: GENERAL_WORKBENCH,
    kind: "read",
    description:
      "只读查询提醒，默认open未完成；未指定时间时查询以今天为中心的366天及无时间待办。指定任一范围边界时排除无时间待办。按到期排序，最多500条及30000字符。关键词只匹配标题。",
    args: remindersArgs,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        keyword: { type: "string" },
        due_from: dateParameter,
        due_to: dateParameter,
        status: { type: "string", enum: ["open", "completed", "all"] },
      },
    },
    async prepare(value, ctx) {
      try {
        const args = remindersArgs.parse(value);
        const applied = reminderRange(args, ctx);
        const includeUntimed = !args.due_from && !args.due_to;
        const status = args.status ?? "open";
        const matching = (await api.listReminders()).filter(
          (item) =>
            matches(item.title, args.keyword) &&
            (status === "all" || (status === "completed") === (item.completed_at !== null)),
        );
        const selected = matching
          .filter((item) =>
            item.due_at === null
              ? includeUntimed
              : item.due_at >= applied.start && item.due_at < applied.end,
          )
          .sort(
            (a, b) => (a.due_at ?? Infinity) - (b.due_at ?? Infinity) || a.key.localeCompare(b.key),
          );
        const plans = selected.map((item): Plan => {
          const reminder = item.reminder;
          const target: AiTarget = {
            kind: "reminder",
            reminderId: reminder.id,
            occurrenceId: item.occurrenceId,
          };
          return {
            target,
            snapshot: { updatedAt: reminder.updated_at },
            fields: {
              title: shortTitle(item.title),
              due: item.due_at === null ? null : formatLocalTime(item.due_at, ctx.timezone),
              repeat: friendlyRepeat(
                reminder.rrule,
                reminder.recurrence_start_at ?? item.due_at ?? ctx.now,
                reminder.timezone,
              ),
              priority: ["无", "低", "中", "高"][item.priority] ?? "无",
              completed: item.completed_at !== null,
              origin: isFinanceReminder(reminder)
                ? "金融"
                : reminder.source === "event"
                  ? "日程生成"
                  : "普通",
            },
            result: {
              target,
              title: item.title,
              when: item.due_at === null ? "无到期时间" : localWhen(item.due_at, ctx.timezone),
              badges: reminderBadges(item),
            },
          };
        });
        return modelData(
          plans,
          {
            from: formatLocalTime(applied.start, ctx.timezone),
            to: formatLocalTime(applied.end, ctx.timezone),
          },
          applied.clipped || (includeUntimed && selected.length < matching.length),
          ctx,
        );
      } catch (error) {
        return failed(error);
      }
    },
  };
  return [events, reminders];
}
