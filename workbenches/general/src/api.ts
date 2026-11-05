import type { DataLayer } from "../../../apps/desktop/src/core/repositories";
import type {
  Memo,
  MemoFields,
  CalendarEvent,
  NewEvent,
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

export type { Memo, CalendarEvent, EventOccurrence, SeriesPatch, SeriesScope, TimeRange };
export type MemoDraft = Pick<MemoFields, "title" | "content" | "pinned" | "tags">;
export type Theme = "system" | "light" | "dark";
export interface MemoFilter {
  query?: string;
  tag?: string;
}
type DataAccess = Pick<DataLayer, "memos" | "settings" | "events">;
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
export function createGeneralApi(getData: () => Promise<DataAccess>) {
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
      return (await getData()).events.create(input);
    },
    async updateEvent(id: string, patch: SeriesPatch) {
      return (await getData()).events.update(id, patch);
    },
    async editEventOccurrence(
      id: string,
      originalStart: number,
      scope: SeriesScope,
      patch: SeriesPatch,
    ) {
      await (await getData()).events.editOccurrence(id, originalStart, scope, patch);
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
