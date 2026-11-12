import { useState } from "react";
import { Button } from "@workbench/ui";
import type { NotificationAction } from "../core/scheduler/notification-port";
import { useReminderNotices, type ReminderNotice } from "./reminder-notices";

function Notice({
  notice,
  onAction,
}: {
  notice: ReminderNotice;
  onAction: (action: NotificationAction) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismiss = useReminderNotices((state) => state.dismiss);
  async function run(kind: "open" | "complete" | "snooze") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const id = notice.occurrenceIds[0];
      if (!id) throw new Error("提醒信息已失效，请到提醒页查看");
      await onAction(
        notice.kind === "missed"
          ? { kind: "missed", count: notice.occurrenceIds.length }
          : { kind, occurrenceId: id },
      );
      dismiss(notice.key);
    } catch (error) {
      setError(error instanceof Error ? error.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="reminder-notice" aria-label={notice.title}>
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
      </svg>
      <div className="reminder-notice-content">
        <button className="reminder-notice-title" disabled={busy} onClick={() => void run("open")}>
          {notice.title}
          {notice.body && <span className="reminder-notice-body">{notice.body}</span>}
        </button>
        {notice.kind === "reminder" && (
          <div className="reminder-notice-actions">
            <Button size="sm" disabled={busy} onClick={() => void run("complete")}>
              完成
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("snooze")}>
              稍后 10 分钟
            </Button>
          </div>
        )}
        {error && (
          <p className="event-form-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <button
        className="reminder-notice-close"
        aria-label={`关闭通知 ${notice.title}`}
        disabled={busy}
        onClick={() => dismiss(notice.key)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="m6 6 12 12M6 18 18 6" />
        </svg>
      </button>
    </section>
  );
}
export function ReminderNotices({
  onAction,
}: {
  onAction: (action: NotificationAction) => Promise<void>;
}) {
  const notices = useReminderNotices((state) => state.notices);
  return (
    <aside
      className="reminder-notices"
      aria-label="软件内通知"
      aria-live="polite"
      aria-relevant="additions"
    >
      {notices.map((notice) => (
        <Notice key={notice.key} notice={notice} onAction={onAction} />
      ))}
    </aside>
  );
}
