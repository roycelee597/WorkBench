import type { AiContext } from "../../../apps/desktop/src/core/ai/action-types";
import { formatLocalTime, parseLocalTime } from "../../../apps/desktop/src/core/ai/local-time";
import { shiftDay } from "./calendar-model";

const relativeDays = new Map([
  ["前天", -2],
  ["昨天", -1],
  ["今天", 0],
  ["明天", 1],
  ["后天", 2],
  ["大后天", 3],
]);
const weekdays = "一二三四五六";
const datePattern =
  /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)|(?:(?:\d{4})\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*[日号]|大后天|前天|昨天|今天|明天|后天|(?<!每)(?:上|本|这|下)?(?:周|星期|礼拜)[一二三四五六日天1-7]/gu;
const changeVerb = /(?:改(?:名)?|挪|移|调整)(?:到|为|成)|推迟|推后|延后|提前/u;
const nonMutating =
  /[？?]|(?:可以|能否|能不能|怎么|如何|要不要|会不会|如果)|(?:不要|别)\s*(?:把|将|改|删|取消|推迟|推后|提前)/u;
const qualifierStart = /^(?:(?:早上|上午|中午|下午|晚上|那场|那条|那次|的)\s*)+/u;
type DateMatch = { day?: string; weekday?: number; monthDay?: string };

function weekday(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

function dateMatch(part: string, today: string): DateMatch | null {
  const offset = relativeDays.get(part);
  if (offset !== undefined) return { day: shiftDay(today, offset) };
  const week = /^(上|本|这|下)?(?:周|星期|礼拜)([一二三四五六日天1-7])$/u.exec(part);
  if (week) {
    const unit = week[2]!;
    const day = weekdays.includes(unit) ? weekdays.indexOf(unit) + 1 : Number(unit) % 7 || 0;
    if (!week[1]) return { weekday: day };
    const weekOffset = week[1] === "下" ? 7 : week[1] === "上" ? -7 : 0;
    return { day: shiftDay(today, weekOffset - ((weekday(today) + 6) % 7) + ((day + 6) % 7)) };
  }
  const chinese = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]$/u.exec(part.replaceAll(/\s/gu, ""));
  const monthDay = chinese && `${chinese[2]!.padStart(2, "0")}-${chinese[3]!.padStart(2, "0")}`;
  const date = chinese ? `${chinese[1] ?? today.slice(0, 4)}-${monthDay}` : part;
  try {
    parseLocalTime(chinese && !chinese[1] ? `2000-${monthDay}` : date, "UTC");
    return chinese && !chinese[1] ? { monthDay: monthDay! } : { day: date };
  } catch {
    return null;
  }
}

export function mutationDateSelector(ctx: AiContext) {
  const text = ctx.userText?.trim() ?? "";
  const today = formatLocalTime(ctx.now, ctx.timezone, true);
  const from = /从\s*([^，,。；;]+?)\s*(?:开始|起)/u.exec(text)?.[1];
  const source = from ?? text.split(changeVerb, 1)[0]!;
  const matches = [...source.matchAll(datePattern)].map(([part]) => dateMatch(part, today));
  const following = from !== undefined && matches.length === 1;
  const exact = following ? matches[0] : null;
  let exactDay = exact?.day;
  if (exact?.weekday !== undefined)
    exactDay = shiftDay(today, (exact.weekday - weekday(today) + 7) % 7);
  if (exact?.monthDay) {
    const year = Number(today.slice(0, 4));
    const day = `${year}-${exact.monthDay}`;
    exactDay = day >= today ? day : `${year + 1}-${exact.monthDay}`;
  }
  // 多个相互冲突的日期可能是范围或并列目标，仍由用户在卡片上选择。
  const constrained = matches.length === 1;
  return {
    constrained,
    following,
    exactDay,
    matches(stamp: number | null) {
      if (!constrained) return true;
      if (stamp === null || matches[0] === null) return false;
      const day = formatLocalTime(stamp, ctx.timezone, true);
      if (exactDay) return day === exactDay;
      const criterion = matches[0]!;
      if (criterion.day) return day === criterion.day;
      if (criterion.monthDay) return day.slice(5) === criterion.monthDay;
      return weekday(day) === criterion.weekday;
    },
  };
}

function numeral(text: string): number {
  if (/^\d+$/u.test(text)) return Number(text);
  const digits = "零一二三四五六七八九";
  const digit = (value: string) => (value === "两" ? 2 : digits.indexOf(value));
  if (!text.includes("十")) return digit(text);
  const [ten, unit] = text.split("十");
  return (ten ? digit(ten) : 1) * 10 + (unit ? digit(unit) : 0);
}

type Timing =
  | { offset: number }
  | { hour: number; minute: number; period: string | undefined; numeric: boolean };

export function requestedOffset(text: string): number | undefined {
  const match =
    /^(推迟|推后|延后|提前)\s*(半小时|[\d零一二两三四五六七八九十]+\s*(?:分钟|小时))[，。！!\s]*$/u.exec(
      text,
    );
  if (!match) return;
  const unit = match[2]!;
  const minutes =
    unit === "半小时"
      ? 30
      : numeral(unit.replace(/\s*(?:分钟|小时)$/u, "")) * (unit.endsWith("小时") ? 60 : 1);
  if (minutes > 0 && minutes <= 24 * 60) return match[1] === "提前" ? -minutes : minutes;
}

function requestedClock(text: string): Timing | undefined {
  const numeric = /^(\d{1,2}):(\d{2})[。！!\s]*$/u.exec(text);
  const colloquial =
    /^(早上|上午|中午|下午|晚上)?\s*([\d零一二两三四五六七八九十]+)\s*点\s*(半|[\d零一二两三四五六七八九十]+分)?[。！!\s]*$/u.exec(
      text,
    );
  if (!numeric && !colloquial) return;
  const hour = numeric ? Number(numeric[1]) : numeral(colloquial![2]!);
  const rest = colloquial?.[3];
  const minute = numeric
    ? Number(numeric[2])
    : rest === "半"
      ? 30
      : rest
        ? numeral(rest.slice(0, -1))
        : 0;
  if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60)
    return { hour, minute, period: colloquial?.[1], numeric: numeric !== null };
}

export function localTimeChange(stamp: number, timezone: string, timing: Timing): string {
  if ("offset" in timing) return formatLocalTime(stamp + timing.offset * 60_000, timezone);
  const time = formatLocalTime(stamp, timezone);
  let { hour } = timing;
  if (/下午|晚上/u.test(timing.period ?? "") && hour < 12) hour += 12;
  if (!timing.numeric && !timing.period && hour > 0 && hour < 12) {
    const original = Number(time.slice(11, 13)) * 60 + Number(time.slice(14));
    if (
      Math.abs(original - (hour + 12) * 60 - timing.minute) <
      Math.abs(original - hour * 60 - timing.minute)
    )
      hour += 12;
  }
  return `${time.slice(0, 11)}${String(hour).padStart(2, "0")}:${String(timing.minute).padStart(2, "0")}`;
}

const eventKeyword = (value: string) =>
  value.replaceAll(datePattern, "").trim().replace(qualifierStart, "").trim();

export function eventTimeIntent(text: string) {
  if (nonMutating.test(text)) return;
  const move = /^(?:请\s*|帮我\s*)*(?:把|将)\s*(.+?)\s*(?:改|挪|移|调整)到\s*(.+)$/u.exec(text);
  if (move) {
    const title = eventKeyword(move[1]!);
    const timing = requestedClock(move[2]!);
    if (title && timing) return { title, timing };
  }
  const shift =
    /^(?:请\s*|帮我\s*)*(?:把|将)?\s*(?:以后每天的)?(.+?)(?:都)?\s*((?:推迟|推后|延后|提前).+?)(?:[，,]\s*从.+?(?:开始|起)[。！!\s]*)?$/u.exec(
      text,
    );
  const offset = shift && requestedOffset(shift[2]!);
  const title = shift && eventKeyword(shift[1]!);
  if (title && typeof offset === "number") return { title, timing: { offset } };
}

export function linkedReminderIntent(text: string): string | undefined {
  if (nonMutating.test(text)) return;
  const match =
    /^(?:请\s*|帮我\s*)*(?:把|将)\s*(.+?)(?:自动带出来|自动生成|生成|的关联|关联的)\s*(?:的)?提醒\s*(?:改|挪|移|调整|推迟|推后|提前).+$/u.exec(
      text,
    );
  if (match) return eventKeyword(match[1]!) || undefined;
}

export function eventDeleteIntent(text: string): string | undefined {
  if (nonMutating.test(text) || /所有|全部|整个系列|每次|一起|一并|都|提醒|备忘录/u.test(text))
    return;
  const request =
    /^(?:(?:请\s*|帮我\s*)*(?:删除|删掉|取消)\s*(.+?)|(.+?)\s*不要了)[。！!\s]*$/u.exec(text);
  if (request) return eventKeyword(request[1] ?? request[2]!) || undefined;
}
