import { useEffect, useState } from "react";
import {
  FileText,
  CalendarDays,
  Bell,
  Trash2,
  RotateCcw,
  ArchiveRestore,
  Clock3,
} from "lucide-react";
import { Button, Dialog, cn } from "@workbench/ui";
import { memoTitle } from "../api";
import { markdownSummary } from "../markdown";
import { workspace } from "../workspace-store";

type Category = "memos" | "events";
interface Target {
  id: string;
  title: string;
  kind: Category;
}
export function TrashPage() {
  const state = workspace.useWorkspace();
  const [category, setCategory] = useState<Category>("memos");
  const [target, setTarget] = useState<Target | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const refreshTrash = state.refreshTrash;
  useEffect(() => {
    const timer = setInterval(() => {
      void refreshTrash();
      setNow(Date.now());
    }, 60_000);
    return () => clearInterval(timer);
  }, [refreshTrash]);
  // 同次联动删除的例外由原系列统一恢复，避免列表中重复出现整组记录。
  const deletedEvents = state.deletedEvents.filter(
    (event) =>
      !event.recurrence_id ||
      !state.deletedEvents.some(
        (parent) =>
          parent.id === event.recurrence_id && parent.deletion_group_id === event.deletion_group_id,
      ),
  );
  const rows =
    category === "memos"
      ? state.deleted.map((memo) => ({
          id: memo.id,
          title: memoTitle(memo),
          summary: markdownSummary(memo.content) || "没有正文",
          deletedAt: memo.deleted_at!,
        }))
      : deletedEvents.map((event) => ({
          id: event.id,
          title: event.title,
          summary: `${event.recurrence_id ? "系列例外 · " : event.rrule ? "重复日程 · " : ""}${new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: event.timezone }).format(event.start_at)} · 关联提醒随日程恢复`,
          deletedAt: event.deleted_at!,
        }));
  return (
    <section className="utility-page trash-page">
      <div className="utility-heading">
        <div>
          <div className="eyebrow">留一点反悔的余地</div>
          <h1>回收站</h1>
          <p>删除的内容在这里保留 30 天，期间随时可以恢复。</p>
        </div>
        <div className="utility-illustration">
          <ArchiveRestore size={32} strokeWidth={1.3} />
        </div>
      </div>
      <div className="trash-categories" aria-label="回收站内容类型">
        <button
          type="button"
          className={cn(category === "memos" && "active")}
          aria-pressed={category === "memos"}
          onClick={() => setCategory("memos")}
        >
          <FileText size={15} />
          备忘录 <b>{state.deleted.length}</b>
        </button>
        <button
          type="button"
          className={cn(category === "events" && "active")}
          aria-pressed={category === "events"}
          onClick={() => setCategory("events")}
        >
          <CalendarDays size={15} />
          日程 <b>{deletedEvents.length}</b>
        </button>
        <span aria-disabled="true">
          <Bell size={15} />
          提醒事项 <small>准备中</small>
        </span>
      </div>
      <div className="trash-info">
        <Clock3 size={15} />
        <p>
          超过 30
          天的内容会自动清空。永久删除后，内容无法恢复。删除日程时，其关联提醒一起进入回收站。
        </p>
      </div>
      <div className="trash-list">
        {rows.map((row) => (
          <article className="trash-card" key={row.id}>
            <div className="trash-file-icon">
              {category === "memos" ? (
                <FileText size={20} strokeWidth={1.4} />
              ) : (
                <CalendarDays size={20} strokeWidth={1.4} />
              )}
            </div>
            <div className="trash-content">
              <h2>{row.title}</h2>
              <p>{row.summary}</p>
              <span>
                删除于{" "}
                {new Intl.DateTimeFormat("zh-CN", {
                  month: "long",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(row.deletedAt)}
                <span className="mx-2">·</span>剩余{" "}
                {Math.max(0, Math.ceil((row.deletedAt + 30 * 86_400_000 - now) / 86_400_000))} 天
              </span>
            </div>
            <div className="trash-actions">
              <Button
                variant="outline"
                size="sm"
                disabled={state.busy}
                onClick={() =>
                  void (category === "memos"
                    ? state.restoreMemo(row.id)
                    : state.restoreEvent(row.id))
                }
              >
                <RotateCcw />
                恢复
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`永久删除 ${row.title}`}
                title="永久删除"
                disabled={state.busy}
                onClick={() => setTarget({ id: row.id, title: row.title, kind: category })}
              >
                <Trash2 />
              </Button>
            </div>
          </article>
        ))}
        {rows.length === 0 && (
          <div className="trash-empty">
            <div className="empty-icon">
              <ArchiveRestore size={30} strokeWidth={1.3} />
            </div>
            <h2>这一组是空的</h2>
            <p>删除的{category === "memos" ? "备忘录" : "日程和关联提醒"}会暂时留在这里。</p>
          </div>
        )}
      </div>
      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !state.busy) setTarget(null);
        }}
        title={`永久删除这条${target?.kind === "events" ? "日程" : "备忘录"}？`}
        description={`“${target?.title ?? ""}”的内容${target?.kind === "events" ? "及已删除的系列例外、关联提醒" : ""}将被清空，此操作无法撤销。`}
        footer={
          <>
            <Button variant="outline" disabled={state.busy} onClick={() => setTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={state.busy}
              onClick={async () => {
                if (!target) return;
                await (target.kind === "memos"
                  ? state.purgeMemo(target.id)
                  : state.purgeEvent(target.id));
                const current = workspace.useWorkspace.getState();
                if (
                  !(target.kind === "memos" ? current.deleted : current.deletedEvents).some(
                    (row) => row.id === target.id,
                  )
                )
                  setTarget(null);
              }}
            >
              永久删除
            </Button>
          </>
        }
      />
    </section>
  );
}
