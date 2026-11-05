/// <reference types="vite/client" />
import { ReminderScheduler, type NotificationPort } from "./scheduler";
let initialization: Promise<ReminderScheduler> | undefined;
export function initializeReminderRuntime(
  port: NotificationPort,
  onError: (error: unknown) => void,
  onDelivered: () => void,
): Promise<ReminderScheduler> {
  initialization ??= (async () => {
    const { initializeDataLayer } = await import("../repositories/initialize");
    const data = await initializeDataLayer();
    const scheduler = new ReminderScheduler(data, port, undefined, onError, onDelivered);
    await scheduler.start();
    return scheduler;
  })().catch((error: unknown) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    void initialization?.then((scheduler) => scheduler.stop()).catch(() => undefined);
  });
