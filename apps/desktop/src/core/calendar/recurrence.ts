import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { RRule } from "rrule";
import type { CalendarEvent } from "../repositories/models";

dayjs.extend(utc);
dayjs.extend(timezone);
const DAY = 86_400_000;

export interface TimeRange {
  start: number;
  end: number;
}
export interface EventOccurrence {
  key: string;
  series_id: string;
  original_start_at: number;
  start_at: number;
  end_at: number;
  event: CalendarEvent;
  is_exception: boolean;
}

export function floatingTime(timestamp: number, zone: string): number {
  const local = dayjs(timestamp).tz(zone);
  const value = new Date(0);
  value.setUTCFullYear(local.year(), local.month(), local.date());
  value.setUTCHours(local.hour(), local.minute(), local.second(), local.millisecond());
  return value.getTime();
}

// RRULE 只处理不带时区的日历时间，转换在此完成，避免依赖电脑本身的时区。
// 春季不存在的当地时间跳过；秋季重复时间固定选择较早的一次。
export function timestampFromFloating(wallTime: number, zone: string): number | null {
  const offsets = new Set(
    [-36, 0, 36].map((hours) => {
      const sample = wallTime + hours * 3_600_000;
      return floatingTime(sample, zone) - sample;
    }),
  );
  const candidates = [...offsets]
    .map((offset) => wallTime - offset)
    .filter((candidate) => floatingTime(candidate, zone) === wallTime);
  return candidates.length ? Math.min(...candidates) : null;
}

export function parseRule(text: string) {
  if (/[\r\n]/.test(text)) throw new Error("仅支持单条 RRULE，不允许嵌入 DTSTART 或规则集");
  const options = RRule.parseString(text);
  if (
    options.freq === undefined ||
    ![RRule.DAILY, RRule.WEEKLY, RRule.MONTHLY, RRule.YEARLY].includes(options.freq)
  )
    throw new Error("v1 仅支持日、周、月、年重复规则");
  if (options.count != null && (!Number.isSafeInteger(options.count) || options.count <= 0))
    throw new Error("重复次数必须为正整数");
  if (
    options.interval != null &&
    (!Number.isSafeInteger(options.interval) || options.interval <= 0)
  )
    throw new Error("重复间隔必须为正整数");
  if (options.until && !Number.isFinite(options.until.getTime()))
    throw new Error("重复结束时间无效");
  new RRule(options);
  return options;
}

export function serializeRule(options: Parameters<typeof RRule.optionsToString>[0]): string {
  const line = RRule.optionsToString(options)
    .split("\n")
    .find((item) => item.startsWith("RRULE:"));
  if (!line) throw new Error("无法序列化重复规则");
  return line.slice("RRULE:".length);
}

export function seriesStarts(event: CalendarEvent, from: number, to: number): number[] {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to)
    throw new Error("展开范围必须是有效的半开时间区间");
  if (event.rrule === null)
    return event.start_at >= from && event.start_at < to ? [event.start_at] : [];
  const options = parseRule(event.rrule);
  const count = options.count;
  const until = options.until?.getTime();
  const anchor = floatingTime(event.start_at, event.timezone);
  const upper = floatingTime(to, event.timezone) + 2 * DAY;
  const rule = new RRule({
    ...options,
    dtstart: new Date(anchor),
    tzid: null,
    count: null,
    until: null,
  });
  const result: number[] = [];
  let validCount = 0;
  let steps = 0;
  rule.all((date) => {
    if (++steps > 1_000_000) throw new Error("重复日程展开范围过大");
    const wallTime = date.getTime();
    if (wallTime > upper || (count != null && validCount >= count)) return false;
    const actual =
      wallTime === anchor ? event.start_at : timestampFromFloating(wallTime, event.timezone);
    if (actual === null || actual < event.start_at) return true;
    if (until !== undefined && actual > until) return false;
    validCount++;
    if (actual >= from && actual < to) result.push(actual);
    return true;
  });
  return result;
}

function overlaps(start: number, end: number, range: TimeRange): boolean {
  return start === end
    ? start >= range.start && start < range.end
    : start < range.end && end > range.start;
}

export function occurrenceEnd(event: CalendarEvent, start: number, zone = event.timezone): number {
  const duration = event.end_at - event.start_at;
  if (!event.all_day) return start + duration;
  const wallDuration =
    floatingTime(event.end_at, event.timezone) - floatingTime(event.start_at, event.timezone);
  return timestampFromFloating(floatingTime(start, zone) + wallDuration, zone) ?? start + duration;
}

export function expandEvents(
  events: readonly CalendarEvent[],
  range: TimeRange,
): EventOccurrence[] {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start >= range.end
  )
    throw new Error("展开范围无效");
  const active = events.filter((event) => event.deleted_at === null && event.purged_at === null);
  const parents = new Map(
    active.filter((event) => event.recurrence_id === null).map((event) => [event.id, event]),
  );
  const exceptions = active.filter(
    (event) => event.recurrence_id !== null && parents.has(event.recurrence_id),
  );
  const result: EventOccurrence[] = [];
  for (const parent of parents.values()) {
    const excluded = new Set(parent.exdates);
    for (const exception of exceptions) {
      if (exception.recurrence_id === parent.id && exception.original_start_at !== null)
        excluded.add(exception.original_start_at);
    }
    const duration = parent.end_at - parent.start_at;
    for (const start of seriesStarts(parent, range.start - duration - 2 * DAY, range.end)) {
      if (excluded.has(start)) continue;
      const end = occurrenceEnd(parent, start);
      if (overlaps(start, end, range))
        result.push({
          key: `${parent.id}:${start}`,
          series_id: parent.id,
          original_start_at: start,
          start_at: start,
          end_at: end,
          event: { ...parent, exdates: [...parent.exdates] },
          is_exception: false,
        });
    }
  }
  // 例外按实际时间过滤：移入范围要展示，移出范围仍须屏蔽原实例。
  for (const exception of exceptions) {
    if (exception.recurrence_id === null || exception.original_start_at === null) continue;
    if (overlaps(exception.start_at, exception.end_at, range))
      result.push({
        key: `${exception.recurrence_id}:${exception.original_start_at}`,
        series_id: exception.recurrence_id,
        original_start_at: exception.original_start_at,
        start_at: exception.start_at,
        end_at: exception.end_at,
        event: { ...exception, exdates: [...exception.exdates] },
        is_exception: true,
      });
  }
  return result.sort(
    (left, right) => left.start_at - right.start_at || left.key.localeCompare(right.key),
  );
}
