import { v7 } from "uuid";
import type { SqlDatabase } from "../db/database";
import { EventsRepository } from "./events";
import { MemosRepository } from "./memos";
import type { RepositoryContext } from "./models";
import { RemindersRepository } from "./reminders";
import { SettingsRepository } from "./settings";
import { TrashCleaner } from "./trash-cleaner";
import { createChangeSignal } from "./change-signal";
import { ReminderOccurrencesRepository } from "./reminder-occurrences";
import { FinanceThresholdsRepository } from "./finance-thresholds";
import { FinanceAlertStatesRepository } from "./finance-alert-states";
import { AiMessagesRepository } from "./ai-messages";
import { ModuleCleanupRepository } from "./module-cleanup";

export async function createDataLayer(
  db: SqlDatabase,
  options: Partial<Pick<RepositoryContext, "now" | "newId">> = {},
) {
  const changes = createChangeSignal();
  const database: SqlDatabase = {
    select: (query, values) => db.select(query, values),
    batch: async (statements) => {
      const result = await db.batch(statements);
      const tables = new Set<string>();
      for (const [index, statement] of statements.entries()) {
        if (!result[index]) continue;
        const table = /^(?:INSERT INTO|UPDATE|DELETE FROM)\s+"?([a-z_]+)"?\b/i.exec(
          statement.query,
        )?.[1];
        if (table) tables.add(table.toLowerCase());
      }
      changes.emit(tables);
      return result;
    },
  };
  const seed: RepositoryContext = {
    now: options.now ?? Date.now,
    newId: options.newId ?? v7,
    deviceId: "",
  };
  seed.deviceId = seed.newId();
  const settingsSeed = new SettingsRepository(database, seed);
  const deviceId = await settingsSeed.ensureDeviceId();
  const context = { ...seed, deviceId };
  const settings = new SettingsRepository(database, context);
  return {
    deviceId,
    changes,
    memos: new MemosRepository(database, context),
    events: new EventsRepository(database, context),
    reminders: new RemindersRepository(database, context),
    occurrences: new ReminderOccurrencesRepository(database, context),
    financeThresholds: new FinanceThresholdsRepository(database, context),
    financeAlertStates: new FinanceAlertStatesRepository(database, context),
    // 对话记录变动不刷新日程页面，也不唤醒提醒调度。
    aiMessages: new AiMessagesRepository(db, context),
    moduleCleanup: new ModuleCleanupRepository(database, context),
    settings,
    trash: new TrashCleaner(database, context, settings),
  };
}

export type DataLayer = Awaited<ReturnType<typeof createDataLayer>>;
