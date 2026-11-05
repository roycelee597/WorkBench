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

export async function createDataLayer(
  db: SqlDatabase,
  options: Partial<Pick<RepositoryContext, "now" | "newId">> = {},
) {
  const changes = createChangeSignal();
  const database: SqlDatabase = {
    select: (query, values) => db.select(query, values),
    batch: async (statements) => {
      const result = await db.batch(statements);
      changes.emit();
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
    settings,
    trash: new TrashCleaner(database, context, settings),
  };
}

export type DataLayer = Awaited<ReturnType<typeof createDataLayer>>;
