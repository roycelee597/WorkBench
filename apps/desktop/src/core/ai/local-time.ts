import { floatingTime, timestampFromFloating } from "../calendar/recurrence";

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format(0);
  } catch {
    throw new Error("时区无效");
  }
}

export function parseLocalTime(value: string, timezone: string): number {
  validateTimezone(timezone);
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(value))
    throw new Error("请使用 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm 格式");
  const normalized = value.length === 10 ? `${value}T00:00` : value;
  const wall = Date.parse(`${normalized}:00Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== normalized)
    throw new Error("日期或时间无效");
  const actual = timestampFromFloating(wall, timezone);
  if (actual === null) throw new Error("该当地时间因夏令时不存在，请选择其他时间");
  return actual;
}

export function formatLocalTime(timestamp: number, timezone: string, dateOnly = false): string {
  validateTimezone(timezone);
  if (!Number.isSafeInteger(timestamp) || !Number.isFinite(new Date(timestamp).getTime()))
    throw new Error("时间无效");
  const result = new Date(floatingTime(timestamp, timezone)).toISOString();
  if (!/^\d{4}-/.test(result)) throw new Error("日期超出支持范围");
  return result.slice(0, dateOnly ? 10 : 16);
}
