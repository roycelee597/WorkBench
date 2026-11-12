import { FINANCE_WORKBENCH } from "../core/finance/finance-target";
import type { NotificationAction } from "../core/scheduler/notification-port";
import type { ReminderTarget } from "../core/scheduler/reminder-service";

type ResolvedTarget = ReminderTarget & { sourceWorkbench?: string | null };

export async function dispatchNotification(
  action: NotificationAction,
  port: {
    resolve: (occurrenceId: string, includeSource: boolean) => Promise<ResolvedTarget>;
    complete: (target: ReminderTarget) => Promise<void>;
    snooze: (target: ReminderTarget) => Promise<void>;
    openReminder: (target: ReminderTarget) => Promise<void>;
    openFinance: (reminderId: string) => Promise<void>;
    openMissed: (count: number) => Promise<void>;
  },
) {
  if (action.kind === "missed") return port.openMissed(action.count);
  const target = await port.resolve(action.occurrenceId, action.kind === "open");
  if (action.kind === "complete") return port.complete(target);
  if (action.kind === "snooze") return port.snooze(target);
  return target.sourceWorkbench === FINANCE_WORKBENCH
    ? port.openFinance(target.reminderId)
    : port.openReminder(target);
}
