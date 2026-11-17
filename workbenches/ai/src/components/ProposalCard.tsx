import { Button } from "@workbench/ui";
import type { AiStore } from "../ai-store";

const createLabels: Record<string, { title: string; icon: string }> = {
  calendar_create_event: { title: "新建日程", icon: "日" },
  reminders_create: { title: "新建提醒", icon: "提" },
  memos_create: { title: "新建备忘录", icon: "备" },
};
const statusLabels = {
  pending: "待确认",
  saving: "正在保存…",
  saved: "已保存",
  failed: "保存失败",
  cancelled: "已取消",
  transferring: "正在打开表单…",
  transferred: "已转到表单",
};

export function ProposalCard({ id, store }: { id: string; store: AiStore }) {
  const proposal = store((state) => state.proposals[id]);
  if (!proposal) return <p className="ai-message-note">此操作卡片已失效，请重新说明。</p>;
  const action = store.getState().getProposalAction(id);
  const Preview = action?.Preview;
  const label = createLabels[proposal.actionName] ?? { title: "操作提案", icon: "待" };
  const editable = proposal.status === "pending" || proposal.status === "failed";
  const busy = proposal.status === "saving" || proposal.status === "transferring";
  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-background p-4"
      aria-label={label.title}
    >
      <header className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-semibold">
          <span className="rounded bg-muted px-2 py-1 text-sm" aria-hidden="true">
            {label.icon}
          </span>
          {label.title}
        </h2>
        <span className="text-sm text-muted-foreground" role="status">
          {statusLabels[proposal.status]}
        </span>
      </header>
      {proposal.note && (
        <p className="rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          {proposal.note}
        </p>
      )}
      {/* 校验消息由卡片统一展示，避免预览再次显示同一错误。 */}
      {Preview ? (
        <Preview
          draft={proposal.draft}
          onChange={(draft: unknown) => store.getState().editProposal(id, draft)}
          readOnly={!editable}
          errors={[]}
        />
      ) : (
        <p className="text-destructive">此操作当前不可用，请重新发起或手动新建。</p>
      )}
      {proposal.errors.length > 0 && (
        <div className="space-y-1 text-sm text-destructive" role="alert">
          {proposal.errors.map((error, index) => (
            <p key={index}>{error}</p>
          ))}
        </div>
      )}
      {proposal.result && <p>{proposal.result.message}</p>}
      {proposal.navigationError && (
        <p className="text-sm text-destructive" role="alert">
          {proposal.navigationError}
        </p>
      )}
      {(editable || busy) && (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || !Preview}
            onClick={() => void store.getState().confirmProposal(id)}
          >
            {proposal.status === "saving"
              ? "正在保存…"
              : proposal.status === "failed"
                ? "重试保存"
                : "确认"}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => store.getState().cancelProposal(id)}
          >
            取消
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void store.getState().transferProposal(id)}
          >
            {proposal.status === "transferring" ? "正在打开表单…" : "在表单中打开"}
          </Button>
        </div>
      )}
      {proposal.status === "saved" && proposal.result?.target && (
        <Button
          variant="outline"
          disabled={proposal.openingTarget}
          onClick={() => void store.getState().openProposalTarget(id)}
        >
          {proposal.openingTarget ? "正在打开…" : "查看"}
        </Button>
      )}
    </section>
  );
}
