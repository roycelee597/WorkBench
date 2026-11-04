import { openDatabase } from "../db/database";
import { createDataLayer, type DataLayer } from "./index";
import { startTrashMaintenance } from "./trash-cleaner";

let initialization: Promise<DataLayer> | undefined;

export function initializeDataLayer(): Promise<DataLayer> {
  initialization ??= (async () => {
    const data = await createDataLayer(openDatabase());
    await startTrashMaintenance(data.trash);
    return data;
  })().catch((error: unknown) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}
