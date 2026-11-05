import type { SqlDatabase } from "../db/database";
import type { RepositoryContext } from "./models";
import { EventsRepository } from "./events";
import { MemosRepository } from "./memos";
import { RemindersRepository } from "./reminders";
import { SettingsRepository } from "./settings";
import { ReminderOccurrencesRepository } from "./reminder-occurrences";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const TRASH_RETENTION_MS = 30 * DAY_MS;

export class TrashCleaner {
  constructor(
    private readonly db: SqlDatabase,
    private readonly context: RepositoryContext,
    private readonly settings: SettingsRepository,
  ) {}
  async purgeExpired(): Promise<{ memos: number; events: number; reminders: number }> {
    const now = this.context.now();
    const cutoff = now - TRASH_RETENTION_MS;
    const memo = new MemosRepository(this.db, this.context);
    const events = new EventsRepository(this.db, this.context);
    const reminders = new RemindersRepository(this.db, this.context);
    const results = await this.db.batch([
      memo.purgeStatement("deleted_at < ?", [cutoff], now),
      events.purgeStatement("deleted_at < ?", [cutoff], now),
      reminders.purgeStatement("deleted_at < ?", [cutoff], now),
      new ReminderOccurrencesRepository(this.db, this.context).purgeStatement(
        "deleted_at < ?",
        [cutoff],
        now,
      ),
      this.settings.valueStatement("last_trash_purge_at", now, now),
    ]);
    return { memos: results[0] ?? 0, events: results[1] ?? 0, reminders: results[2] ?? 0 };
  }
}

// 启动时执行一次，之后每 24 小时执行；失败不写成功时间，下次仍可重试。
export async function startTrashMaintenance(
  cleaner: Pick<TrashCleaner, "purgeExpired">,
): Promise<() => void> {
  await cleaner.purgeExpired();
  const timer = setInterval(() => {
    void cleaner.purgeExpired().catch((error: unknown) => console.error("清理回收站失败", error));
  }, DAY_MS);
  return () => clearInterval(timer);
}
