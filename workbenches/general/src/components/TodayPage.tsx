import { useEffect, useRef, useState } from "react";
import { Bell, CalendarDays, Check, Circle, FileText, ArrowUpRight, Pin } from "lucide-react";
import { Button, cn } from "@workbench/ui";
import { generalApi, memoTitle, type ReminderItem } from "../api";
import { watchToday, type TodayData } from "../today-model";
import { workspace } from "../workspace-store";
import { reminderTime } from "../reminder-model";

export function TodayPage() {
  const state = workspace.useWorkspace();
  const [now, setNow] = useState(() => Date.now());
  const [data, setData] = useState<TodayData>({ events: [], reminders: [], memos: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const writing = useRef(false);
  const refresh = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    let current = true;
    const generation = sequence;
    let off: (() => void) | undefined;
    const reload = async () => {
      const id = ++generation.current;
      try {
        const result = await generalApi.loadToday();
        if (current && id === generation.current) {
          setData(result);
          setError(null);
        }
      } catch (error) {
        if (current && id === generation.current)
          setError(error instanceof Error ? error.message : "未能读取今天的内容，请重试。");
      } finally {
        if (current) setLoading(false);
      }
    };
    refresh.current = reload;
    void reload();
    void generalApi
      .subscribeChanges(() => {
        void reload();
      })
      .then((unsubscribe) => {
        if (current) off = unsubscribe;
        else unsubscribe();
      })
      .catch(() => {
        if (current) setError("内容更新监听暂不可用，请重新打开今天页。");
      });
    const day = watchToday(() => {
      void reload();
    }, setNow);
    window.addEventListener("focus", day.check);
    document.addEventListener("visibilitychange", day.check);
    return () => {
      current = false;
      generation.current++;
      off?.();
      day.stop();
      window.removeEventListener("focus", day.check);
      document.removeEventListener("visibilitychange", day.check);
    };
  }, []);
  async function complete(item: ReminderItem) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setError(null);
    try {
      await generalApi.completeReminderItem(item);
      await refresh.current();
    } catch (error) {
      setError(error instanceof Error ? error.message : "未能完成提醒，请重试。");
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  const time = (value: number) =>
    new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(
      value,
    );
  return (
    <section className="today-page" aria-busy={loading}>
      <header className="today-heading">
        <div>
          <div className="eyebrow">把注意力留给今天</div>
          <h2>
            {new Intl.DateTimeFormat("zh-CN", {
              month: "long",
              day: "numeric",
              weekday: "long",
            }).format(now)}
          </h2>
          <p>安排、待办和想法，都在这里。</p>
        </div>
        <span className="today-mark">TODAY</span>
      </header>
      {error && (
        <div className="calendar-error" role="alert">
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={() => void refresh.current()}>
            重试
          </Button>
        </div>
      )}
      <div className="today-grid">
        <section className="today-block today-events">
          <header>
            <CalendarDays size={18} />
            <h3>今天的日程</h3>
            <span>{data.events.length}</span>
          </header>
          {data.events.length ? (
            <div className="today-list">
              {data.events.map((item) => (
                <button
                  key={item.key}
                  disabled={state.busy}
                  className="today-event"
                  onClick={() => void state.openCalendar(item)}
                >
                  <span
                    className="today-event-color"
                    style={{ background: item.event.color ?? "#547c69" }}
                  />
                  <span className="today-event-time">
                    {item.event.all_day ? "全天" : time(item.start_at)}
                  </span>
                  <span>
                    <strong>{item.event.title}</strong>
                    <small>
                      {item.event.all_day
                        ? "全天日程"
                        : `${time(item.start_at)} — ${time(item.end_at)}`}
                    </small>
                  </span>
                  <ArrowUpRight size={14} />
                </button>
              ))}
            </div>
          ) : (
            <p className="today-empty">
              {loading ? "正在读取日程…" : "今天没有日程，留一点从容给自己。"}
            </p>
          )}
        </section>
        <section className="today-block today-reminders">
          <header>
            <Bell size={18} />
            <h3>今天和逾期提醒</h3>
            <span>{data.reminders.length}</span>
          </header>
          {data.reminders.length ? (
            <div className="today-list">
              {data.reminders.map((item) => (
                <article key={item.key} className="today-reminder">
                  <button
                    className="reminder-check"
                    disabled={busy || state.busy}
                    aria-label={`完成 ${item.title}`}
                    onClick={() => void complete(item)}
                  >
                    {busy ? <Check size={18} /> : <Circle size={19} />}
                  </button>
                  <button
                    disabled={state.busy}
                    className="today-reminder-content"
                    onClick={() =>
                      void state.openReminder({
                        reminderId: item.reminder.id,
                        dueAt: item.due_at,
                        scheduleVersion: item.reminder.schedule_version,
                        ...(item.occurrenceId ? { occurrenceId: item.occurrenceId } : {}),
                      })
                    }
                  >
                    <strong>
                      {item.reminder.source === "event" && <CalendarDays size={14} />} {item.title}
                    </strong>
                    <small className={cn(item.due_at! < now && "overdue")}>
                      {reminderTime(item)}
                      {item.due_at! < now && <b>逾期</b>}
                    </small>
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <p className="today-empty">{loading ? "正在读取提醒…" : "今天没有待完成的提醒。"}</p>
          )}
        </section>
        <section className="today-block today-memos">
          <header>
            <Pin size={18} />
            <h3>置顶备忘录</h3>
            <span>{data.memos.length}</span>
          </header>
          {data.memos.length ? (
            <div className="today-memo-grid">
              {data.memos.map((memo) => (
                <button
                  key={memo.id}
                  className="today-memo"
                  disabled={state.busy}
                  onClick={() => void state.openMemo(memo.id)}
                >
                  <FileText size={17} />
                  <strong>{memoTitle(memo)}</strong>
                  <p>{memo.preview || "还没有正文"}</p>
                  <ArrowUpRight size={14} />
                </button>
              ))}
            </div>
          ) : (
            <p className="today-empty">
              {loading ? "正在读取备忘录…" : "在备忘录中置顶，重要的想法就会出现在这里。"}
            </p>
          )}
        </section>
      </div>
    </section>
  );
}
