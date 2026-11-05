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
import { Button, Dialog } from "@workbench/ui";
import { memoTitle, type Memo } from "../api";
import { markdownSummary } from "../markdown";
import { workspace } from "../workspace-store";

export function TrashPage() {
  const state = workspace.useWorkspace();
  const [target, setTarget] = useState<Memo | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const refreshTrash = state.refreshTrash;
  useEffect(() => {
    // 刷新展示缓存，清理任务仍由数据层的单一定时器负责。
    const timer = setInterval(() => {
      void refreshTrash();
      setNow(Date.now());
    }, 60_000);
    return () => clearInterval(timer);
  }, [refreshTrash]);
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
        <span className="active">
          <FileText size={15} />
          备忘录 <b>{state.deleted.length}</b>
        </span>
        <span aria-disabled="true">
          <CalendarDays size={15} />
          日程 <small>准备中</small>
        </span>
        <span aria-disabled="true">
          <Bell size={15} />
          提醒事项 <small>准备中</small>
        </span>
      </div>
      <div className="trash-info">
        <Clock3 size={15} />
        <p>超过 30 天的内容会自动清空。永久删除后，内容无法恢复。</p>
      </div>
      <div className="trash-list">
        {state.deleted.map((memo) => (
          <article className="trash-card" key={memo.id}>
            <div className="trash-file-icon">
              <FileText size={20} strokeWidth={1.4} />
            </div>
            <div className="trash-content">
              <h2>{memoTitle(memo)}</h2>
              <p>{markdownSummary(memo.content) || "没有正文"}</p>
              <span>
                删除于{" "}
                {new Intl.DateTimeFormat("zh-CN", {
                  month: "long",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(memo.deleted_at!)}
                <span className="mx-2">·</span>剩余{" "}
                {Math.max(0, Math.ceil((memo.deleted_at! + 30 * 86_400_000 - now) / 86_400_000))} 天
              </span>
            </div>
            <div className="trash-actions">
              <Button
                variant="outline"
                size="sm"
                disabled={state.busy}
                onClick={() => void state.restoreMemo(memo.id)}
              >
                <RotateCcw />
                恢复
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`永久删除 ${memoTitle(memo)}`}
                title="永久删除"
                disabled={state.busy}
                onClick={() => setTarget(memo)}
              >
                <Trash2 />
              </Button>
            </div>
          </article>
        ))}
        {state.deleted.length === 0 && (
          <div className="trash-empty">
            <div className="empty-icon">
              <ArchiveRestore size={30} strokeWidth={1.3} />
            </div>
            <h2>回收站是空的</h2>
            <p>删除的备忘录会暂时留在这里。</p>
          </div>
        )}
      </div>
      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !state.busy) setTarget(null);
        }}
        title="永久删除这条备忘录？"
        description={`“${target ? memoTitle(target) : ""}”的标题、正文和标签将被清空，此操作无法撤销。`}
        footer={
          <>
            <Button variant="outline" disabled={state.busy} onClick={() => setTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={state.busy}
              onClick={async () => {
                if (target) {
                  await state.purgeMemo(target.id);
                  if (
                    !workspace.useWorkspace.getState().deleted.some((memo) => memo.id === target.id)
                  )
                    setTarget(null);
                }
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
