import type { DataLayer } from "../../../apps/desktop/src/core/repositories";
import type {
  Memo,
  MemoFields,
  CalendarEvent,
  NewEvent,
  NewReminder,
  Reminder,
  ReminderFields,
} from "../../../apps/desktop/src/core/repositories/models";
import {
  expandEvents,
  type TimeRange,
  type EventOccurrence,
} from "../../../apps/desktop/src/core/calendar/recurrence";
import type {
  SeriesPatch,
  SeriesScope,
} from "../../../apps/desktop/src/core/calendar/series-mutations";
import { reminderChoices } from "./calendar-model";
import { markdownSummary } from "./markdown";
import {
  completeReminder,
  snoozeReminder,
  loadReminderItems,
  type ReminderItem,
  type ReminderTarget,
} from "../../../apps/desktop/src/core/scheduler/reminder-service";
import { hostServices, offerAutostart } from "./host-services";

export type {
  Memo,
  CalendarEvent,
  EventOccurrence,
  SeriesPatch,
  SeriesScope,
  TimeRange,
  Reminder,
  ReminderItem,
  ReminderTarget,
};
export type ReminderDraft = Pick<
  ReminderFields,
  "title" | "notes" | "due_at" | "rrule" | "priority" | "timezone"
>;
export type MemoDraft = Pick<MemoFields, "title" | "content" | "pinned" | "tags">;
export type Theme = "system" | "light" | "dark";
export interface MemoFilter {
  query?: string;
  tag?: string;
}
type DataAccess = Pick<
  DataLayer,
  "memos" | "settings" | "events" | "reminders" | "occurrences" | "changes"
>;
const fold = (value: string) => value.toLocaleLowerCase("zh-CN");

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags
    .map((tag) => tag.trim())
    .filter((tag) => {
      const key = fold(tag);
      if (!tag || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
export function memoTitle(memo: Pick<Memo, "title" | "content">): string {
  return (
    memo.title.trim() ||
    markdownSummary(memo.content)
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ||
    "未命名备忘录"
  );
}
export function filterMemos(memos: readonly Memo[], filter: MemoFilter = {}): Memo[] {
  const query = fold(filter.query?.trim() ?? "");
  return memos
    .filter((memo) => memo.deleted_at === null && memo.purged_at === null)
    .filter((memo) => !filter.tag || memo.tags.some((tag) => fold(tag) === fold(filter.tag!)))
    .filter(
      (memo) =>
        !query ||
        fold(
          [memo.title, memo.content, markdownSummary(memo.content), ...memo.tags].join("\n"),
        ).includes(query),
    )
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updated_at - a.updated_at ||
        a.id.localeCompare(b.id),
    );
}
export function knownTags(memos: readonly Memo[]): string[] {
  return normalizeTags(
    memos
      .filter((memo) => memo.deleted_at === null && memo.purged_at === null)
      .flatMap((memo) => memo.tags),
  ).sort((a, b) => a.localeCompare(b, "zh-CN"));
}
export function createGeneralApi(
  getData: () => Promise<DataAccess>,
  options: { now?: () => number; offerAutostart?: () => void } = {},
) {
  async function prompt(timed: boolean) {
    if (!timed) return;
    try {
      if (await (await getData()).settings.claimAutostartPrompt())
        (options.offerAutostart ?? offerAutostart)();
    } catch (error) {
      console.error("自启提示状态保存失败，可在设置页手动开启", error);
    }
  }
  return {
    async load() {
      const data = await getData();
      const [memos, deleted, preference] = await Promise.all([
        data.memos.list(),
        data.memos.listDeleted(),
        data.settings.getValue("theme"),
      ]);
      const theme: Theme = preference === "light" || preference === "dark" ? preference : "system";
      return { memos: filterMemos(memos), deleted, theme };
    },
    async createMemo() {
      return (await getData()).memos.create();
    },
    async saveMemo(id: string, draft: MemoDraft) {
      return (await getData()).memos.update(id, { ...draft, tags: normalizeTags(draft.tags) });
    },
    async deleteMemo(id: string) {
      return (await getData()).memos.softDelete(id);
    },
    async listDeleted() {
      return (await getData()).memos.listDeleted();
    },
    async restoreMemo(id: string) {
      return (await getData()).memos.restore(id);
    },
    async purgeMemo(id: string) {
      return (await getData()).memos.purgeContent(id);
    },
    async setTheme(theme: Theme) {
      if (!["system", "light", "dark"].includes(theme)) throw new Error("主题选项无效");
      await (await getData()).settings.setValue("theme", theme);
    },
    async loadCalendar(range: TimeRange) {
      const data = await getData();
      const [events, preference] = await Promise.all([
        data.events.list(),
        data.settings.getValue("default_event_remind"),
      ]);
      const defaultReminder =
        typeof preference === "number" &&
        reminderChoices.some((choice) => choice.value === preference)
          ? preference
          : null;
      return { events, occurrences: expandEvents(events, range), defaultReminder };
    },
    async createEvent(input: NewEvent) {
      const result = await (await getData()).events.create(input);
      await prompt(result.remind_before_minutes !== null);
      return result;
    },
    async updateEvent(id: string, patch: SeriesPatch) {
      const result = await (await getData()).events.update(id, patch);
      await prompt(result.remind_before_minutes !== null);
      return result;
    },
    async editEventOccurrence(
      id: string,
      originalStart: number,
      scope: SeriesScope,
      patch: SeriesPatch,
    ) {
      await (await getData()).events.editOccurrence(id, originalStart, scope, patch);
      await prompt(
        patch.remind_before_minutes !== undefined
          ? patch.remind_before_minutes !== null
          : (await (await getData()).events.get(id))?.remind_before_minutes != null,
      );
    },
    async deleteEventOccurrence(id: string, originalStart: number, scope: SeriesScope) {
      await (await getData()).events.deleteOccurrence(id, originalStart, scope);
    },
    async deleteEvent(id: string) {
      return (await getData()).events.softDelete(id);
    },
    async listDeletedEvents() {
      return (await getData()).events.listDeleted();
    },
    async restoreEvent(id: string) {
      return (await getData()).events.restore(id);
    },
    async purgeEvent(id: string) {
      return (await getData()).events.purgeContent(id);
    },
    async getDefaultEventReminder() {
      const preference = await (await getData()).settings.getValue("default_event_remind");
      return typeof preference === "number" &&
        reminderChoices.some((choice) => choice.value === preference)
        ? preference
        : null;
    },
    async setDefaultEventReminder(minutes: number | null) {
      if (!reminderChoices.some((choice) => choice.value === minutes))
        throw new Error("提前提醒选项无效");
      await (await getData()).settings.setValue("default_event_remind", minutes);
    },
    async listReminders() {
      return loadReminderItems(await getData());
    },
    async createReminder(input: NewReminder) {
      const row = await (await getData()).reminders.create(input);
      await prompt(row.due_at !== null);
      return row;
    },
    async saveReminder(id: string, draft: ReminderDraft, expected?: Reminder) {
      const data = await getData();
      const current = await data.reminders.get(id);
      if (!current) throw new Error("提醒已删除");
      if (
        expected &&
        (current.updated_at !== expected.updated_at ||
          current.schedule_version !== expected.schedule_version ||
          current.due_at !== expected.due_at ||
          current.notified_at !== expected.notified_at ||
          current.completed_at !== expected.completed_at ||
          current.snooze_until !== expected.snooze_until)
      )
        throw new Error("提醒已发生变化，请关闭表单后重新打开");
      const patch: Partial<ReminderFields> = {};
      for (const key of ["title", "notes", "due_at", "rrule", "priority", "timezone"] as const)
        if (current[key] !== draft[key]) Object.assign(patch, { [key]: draft[key] });
      const saved = await data.reminders.update(id, patch);
      await prompt(saved.due_at !== null);
      return saved;
    },
    async completeReminder(target: ReminderTarget) {
      await completeReminder(await getData(), target, (options.now ?? Date.now)());
    },
    async snoozeReminder(target: ReminderTarget) {
      await snoozeReminder(await getData(), target);
    },
    async deleteReminder(id: string) {
      return (await getData()).reminders.softDelete(id);
    },
    async listDeletedReminders() {
      return (await getData()).reminders.listDeleted();
    },
    async restoreReminder(id: string) {
      return (await getData()).reminders.restore(id);
    },
    async purgeReminder(id: string) {
      return (await getData()).reminders.purgeContent(id);
    },
    async subscribeChanges(listener: () => void) {
      return (await getData()).changes.subscribe(listener);
    },
    async getAutostart() {
      return hostServices.getAutostart();
    },
    async setAutostart(enabled: boolean) {
      await hostServices.setAutostart(enabled);
      await (await getData()).settings.setValue("autostart", enabled);
    },
    async reminderTarget(occurrenceId: string) {
      const row = await (await getData()).occurrences.get(occurrenceId);
      if (!row) throw new Error("这条通知对应的提醒已删除");
      return { reminderId: row.reminder_id, occurrenceId: row.id };
    },
  };
}
export type GeneralApi = ReturnType<typeof createGeneralApi>;

// Phase 1 的内置工作台入口：规格 §1 允许经此文件调用 core；Phase 2 只替换此处为 SDK。
// initializeDataLayer 内部只启动一份“启动时 + 每 24 小时”的回收站清理任务。
export const generalApi = createGeneralApi(async () => {
  const { initializeDataLayer } =
    await import("../../../apps/desktop/src/core/repositories/initialize");
  return initializeDataLayer();
});
