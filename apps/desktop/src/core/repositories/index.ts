import { v7 } from "uuid";
import type { SqlDatabase } from "../db/database";
import { EventsRepository } from "./events";
import { MemosRepository } from "./memos";
import type { RepositoryContext } from "./models";
import { RemindersRepository } from "./reminders";
import { SettingsRepository } from "./settings";
import { TrashCleaner } from "./trash-cleaner";

export async function createDataLayer(
  db: SqlDatabase,
  options: Partial<Pick<RepositoryContext, "now" | "newId">> = {},
) {
  const seed: RepositoryContext = {
    now: options.now ?? Date.now,
    newId: options.newId ?? v7,
    deviceId: "",
  };
  seed.deviceId = seed.newId();
  const settingsSeed = new SettingsRepository(db, seed);
  const deviceId = await settingsSeed.ensureDeviceId();
  const context = { ...seed, deviceId };
  const settings = new SettingsRepository(db, context);
  return {
    deviceId,
    memos: new MemosRepository(db, context),
    events: new EventsRepository(db, context),
    reminders: new RemindersRepository(db, context),
    settings,
    trash: new TrashCleaner(db, context, settings),
  };
}

export type DataLayer = Awaited<ReturnType<typeof createDataLayer>>;
