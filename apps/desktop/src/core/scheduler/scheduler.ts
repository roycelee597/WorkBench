import type { DataLayer } from "../repositories";
import type { ReminderOccurrence } from "../repositories/models";
import { currentReminderDue, eventGuards, readyOccurrences } from "./reminder-service";
import { nextAfterOccurrence, validOccurrence } from "./reminder-time";

export const POLL_MS = 30_000;
export interface NotificationMessage {
  kind: "reminder" | "missed";
  title: string;
  body: string;
  occurrenceIds: string[];
}
export interface NotificationPort {
  show(message: NotificationMessage): Promise<void>;
  dispose?: () => Promise<void>;
}
export interface SchedulerClock {
  now: () => number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}
const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
};
export class ReminderScheduler {
  private readonly bootTime: number;
  private startup = true;
  private disposed = false;
  private dirty = false;
  private running: Promise<void> | null = null;
  private exact: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private retryAt = 0;
  constructor(
    private readonly data: DataLayer,
    private readonly notifications: NotificationPort,
    private readonly clock: SchedulerClock = realClock,
    private readonly onError: (error: unknown) => void = console.error,
    private readonly onDelivered: () => void = () => undefined,
  ) {
    this.bootTime = clock.now();
  }
  async start() {
    if (this.poll !== undefined) return;
    this.unsubscribe = this.data.changes.subscribe(() => {
      void this.wake();
    });
    this.poll = this.clock.setInterval(() => {
      void this.wake();
    }, POLL_MS);
    await this.wake();
  }
  stop() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    if (this.exact !== undefined) this.clock.clearTimeout(this.exact);
    if (this.poll !== undefined) this.clock.clearInterval(this.poll);
    this.exact = undefined;
    this.poll = undefined;
    void this.notifications
      .dispose?.()
      .catch((error: unknown) => console.error("停止通知监听失败", error));
  }
  wake(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.dirty = true;
    if (this.running) return this.running;
    this.running = (async () => {
      while (this.dirty && !this.disposed) {
        this.dirty = false;
        try {
          if (this.clock.now() < this.retryAt) {
            this.arm(this.retryAt);
            break;
          }
          await this.tick();
          this.startup = false;
          this.retryAt = 0;
        } catch (error) {
          this.retryAt = this.clock.now() + POLL_MS;
          this.dirty = false;
          this.arm(this.retryAt);
          this.onError(error);
          break;
        }
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private arm(at: number | null) {
    if (this.exact !== undefined) this.clock.clearTimeout(this.exact);
    this.exact = undefined;
    if (at !== null && !this.disposed)
      this.exact = this.clock.setTimeout(
        () => {
          void this.wake();
        },
        Math.max(1, Math.min(2_147_483_647, at - this.clock.now())),
      );
  }
  private async send(
    message: NotificationMessage,
    claims: { row: ReminderOccurrence; at: number }[],
  ) {
    try {
      await this.notifications.show(message);
      this.onDelivered();
    } catch (error) {
      for (const claim of claims)
        await this.data.occurrences.retryNotification(claim.row.id, claim.at);
      throw error;
    }
  }
  private async tick() {
    let [parents, events, rows] = await Promise.all([
      this.data.reminders.list(),
      this.data.events.list(),
      this.data.occurrences.list(),
    ]);
    const now = this.clock.now();
    for (const row of rows) {
      const parent = parents.find((parent) => parent.id === row.reminder_id);
      if (row.completed_at === null && (!parent || !validOccurrence(row, parent, events)))
        await this.data.occurrences.softDelete(row.id);
    }
    for (const parent of parents) {
      if (parent.completed_at !== null || parent.notified_at !== null) continue;
      const due = currentReminderDue(parent, events);
      if (due !== null && (parent.snooze_until ?? due) <= now)
        await this.data.occurrences.ensure(parent, due);
    }
    [parents, events, rows] = await Promise.all([
      this.data.reminders.list(),
      this.data.events.list(),
      this.data.occurrences.list(),
    ]);
    const ready = readyOccurrences(rows, parents, events, now);
    const missed: { row: ReminderOccurrence; at: number }[] = [];
    try {
      for (const { row, parent } of ready) {
        if (this.disposed) return;
        const at = this.clock.now();
        const next = nextAfterOccurrence(parent, row.due_at, at, events);
        if (
          !(await this.data.occurrences.claim(row, parent, next, eventGuards(parent, events), at))
        )
          continue;
        const claim = { row, at };
        if (
          this.startup &&
          parent.created_at < this.bootTime &&
          (row.snooze_until ?? row.due_at!) < this.bootTime
        )
          missed.push(claim);
        else
          await this.send(
            {
              kind: "reminder",
              title: row.title,
              body: row.notes.split(/\r?\n/, 1)[0] ?? "",
              occurrenceIds: [row.id],
            },
            [claim],
          );
      }
    } catch (error) {
      // 同一轮的其他通知失败时，也释放尚未发出的启动汇总，避免永久遗漏。
      for (const claim of missed)
        await this.data.occurrences.retryNotification(claim.row.id, claim.at);
      throw error;
    }
    if (missed.length)
      await this.send(
        {
          kind: "missed",
          title: `你有 ${missed.length} 条错过的提醒`,
          body: "打开 WorkBench 查看今天的提醒。",
          occurrenceIds: missed.map((claim) => claim.row.id),
        },
        missed,
      );
    const [current, currentEvents, currentRows] = await Promise.all([
      this.data.reminders.list(),
      this.data.events.list(),
      this.data.occurrences.list(),
    ]);
    const times: number[] = [];
    for (const parent of current) {
      if (parent.completed_at !== null || parent.notified_at !== null) continue;
      const due = currentReminderDue(parent, currentEvents);
      const fulfilled = currentRows.some(
        (row) =>
          row.reminder_id === parent.id &&
          row.schedule_key === parent.schedule_version &&
          row.due_at === due &&
          (row.completed_at !== null || row.notified_at !== null),
      );
      if (due !== null && !fulfilled) times.push(parent.snooze_until ?? due);
    }
    for (const row of currentRows) {
      const parent = current.find((parent) => parent.id === row.reminder_id);
      if (
        parent &&
        row.completed_at === null &&
        row.notified_at === null &&
        row.due_at !== null &&
        validOccurrence(row, parent, currentEvents)
      )
        times.push(row.snooze_until ?? row.due_at);
    }
    this.arm(
      times.length ? times.reduce((minimum, time) => Math.min(minimum, time), Infinity) : null,
    );
  }
}
