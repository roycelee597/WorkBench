import type { EventOccurrence, Memo, ReminderItem } from "./api";

export function localDayRange(now: number) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}
export function localDateKey(now: number) {
  const date = new Date(now);
  return `${Intl.DateTimeFormat().resolvedOptions().timeZone}:${date.getFullYear()}-${date.getMonth()}-${date.getDate()}:${date.getTimezoneOffset()}`;
}
export interface TodayData {
  events: EventOccurrence[];
  reminders: ReminderItem[];
  memos: (Memo & { preview: string })[];
}
export function sortTodayEvents(events: EventOccurrence[]) {
  return [...events].sort(
    (a, b) =>
      Number(b.event.all_day) - Number(a.event.all_day) ||
      a.start_at - b.start_at ||
      a.key.localeCompare(b.key),
  );
}
export function todayReminders(items: ReminderItem[], now: number) {
  const { end } = localDayRange(now);
  return items
    .filter((item) => item.completed_at === null && item.due_at !== null && item.due_at < end)
    .sort((a, b) => a.due_at! - b.due_at! || b.priority - a.priority || a.key.localeCompare(b.key));
}
export interface DayClock {
  now: () => number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}
// 午夜精确定时，加上轮询和窗口恢复检查，涵盖睡眠及系统日期/时区变化。
export function watchToday(
  changed: (now: number) => void,
  pulse: (now: number) => void,
  clock: DayClock = {
    now: () => Date.now(),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  },
) {
  let key = localDateKey(clock.now());
  let timeout: ReturnType<typeof setTimeout>;
  function arm() {
    timeout = clock.setTimeout(
      check,
      Math.max(1, localDayRange(clock.now()).end - clock.now() + 5),
    );
  }
  function check() {
    clock.clearTimeout(timeout);
    const now = clock.now();
    const next = localDateKey(now);
    pulse(now);
    if (next !== key) {
      key = next;
      changed(now);
    }
    arm();
  }
  arm();
  const poll = clock.setInterval(check, 30_000);
  return {
    check,
    stop: () => {
      clock.clearTimeout(timeout);
      clock.clearInterval(poll);
    },
  };
}
