import type { NotificationMessage, NotificationPort } from "./scheduler";

export type NotificationAction =
  | { kind: "open" | "complete" | "snooze"; occurrenceId: string }
  | { kind: "missed"; count: number };
export interface NotificationDisplay {
  showMain: () => Promise<void>;
  push: (message: NotificationMessage) => void;
}
// 先唤起窗口，再发布到软件内通知区；失败由调度器释放回执并重试。
export function createInAppNotificationPort(display: NotificationDisplay): NotificationPort {
  return {
    async show(message) {
      await display.showMain();
      display.push(message);
    },
  };
}
