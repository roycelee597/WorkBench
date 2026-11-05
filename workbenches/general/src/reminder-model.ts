import type { Reminder, ReminderDraft, ReminderItem } from "./api";
import {
  buildRule,
  parseLocal,
  readRepeat,
  reanchorRule,
  timeInZone,
  type RepeatDraft,
} from "./calendar-model";
export type ReminderGroup = "today" | "planned" | "all" | "completed";
export const reminderGroups = [
  { value: "today", label: "今天" },
  { value: "planned", label: "计划中" },
  { value: "all", label: "全部" },
  { value: "completed", label: "已完成" },
] as const;
export const priorities = ["无", "低", "中", "高"] as const;
export interface ReminderFormDraft {
  title: string;
  notes: string;
  timed: boolean;
  due: string;
  zone: string;
  priority: number;
  repeat: RepeatDraft;
}
export function reminderForm(reminder?: Reminder, now = Date.now()): ReminderFormDraft {
  const zone = reminder?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const start = reminder?.due_at ?? now + 3_600_000;
  return {
    title: reminder?.title ?? "",
    notes: reminder?.notes ?? "",
    timed: reminder?.due_at != null,
    due: timeInZone(start, zone),
    zone,
    priority: reminder?.priority ?? 0,
    repeat: readRepeat(reminder?.rrule ?? null, reminder?.recurrence_start_at ?? start, zone),
  };
}
export function reminderFields(
  draft: ReminderFormDraft,
  initial?: ReminderFormDraft,
  original?: Reminder,
): ReminderDraft {
  if (!draft.title.trim()) throw new Error("请填写提醒标题");
  const due =
    original && initial && draft.timed === initial.timed && draft.due === initial.due
      ? original.due_at
      : draft.timed
        ? parseLocal(draft.due, draft.zone)
        : null;
  let rrule = due === null ? null : buildRule(draft.repeat, due, draft.zone);
  if (original && initial && JSON.stringify(draft.repeat) === JSON.stringify(initial.repeat)) {
    if (due === original.due_at) rrule = original.rrule;
    else if (due !== null && original.due_at !== null && original.rrule)
      rrule = reanchorRule(original.rrule, original.due_at, due, draft.zone);
  }
  if (!Number.isInteger(draft.priority) || draft.priority < 0 || draft.priority > 3)
    throw new Error("优先级无效");
  return {
    title: draft.title.trim(),
    notes: draft.notes,
    due_at: due,
    rrule,
    priority: draft.priority,
    timezone: draft.zone,
  };
}
export function filterReminders(
  items: readonly ReminderItem[],
  group: ReminderGroup,
  now: number,
): ReminderItem[] {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1);
  return items
    .filter((item) =>
      group === "completed"
        ? item.completed_at !== null
        : item.completed_at === null &&
          (group === "all" ||
            (item.due_at !== null &&
              (group === "planned" || (item.snooze_until ?? item.due_at) < end.getTime()))),
    )
    .sort((a, b) =>
      group === "completed"
        ? b.completed_at! - a.completed_at! || a.key.localeCompare(b.key)
        : (a.snooze_until ?? a.due_at ?? Infinity) - (b.snooze_until ?? b.due_at ?? Infinity) ||
          b.priority - a.priority ||
          a.key.localeCompare(b.key),
    );
}
export function reminderTime(
  item: Pick<ReminderItem, "due_at" | "snooze_until">,
  zone?: string,
): string {
  const due = item.snooze_until ?? item.due_at;
  if (due === null) return "无到期时间";
  return `${item.snooze_until !== null ? "稍后提醒 · " : ""}${new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: zone }).format(due)}`;
}
