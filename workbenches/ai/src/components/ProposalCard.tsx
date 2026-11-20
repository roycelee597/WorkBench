import { Button } from "@workbench/ui";
import type { AiStore } from "../ai-store";

const createLabels: Record<string, { title: string; icon: string }> = {
  calendar_create_event: { title: "新建日程", icon: "日" },
  reminders_create: { title: "新建提醒", icon: "提" },
  memos_create: { title: "新建备忘录", icon: "备" },
  calendar_update_event: { title: "修改日程", icon: "改" },
  reminders_update: { title: "修改提醒", icon: "改" },
  calendar_delete_event: { title: "删除日程", icon: "删" },
  reminders_delete: { title: "删除提醒", icon: "删" },
};
const statusLabels = {
  pending: "待确认",
  saving: "正在保存…",
  saved: "已保存",
  failed: "保存失败",
  cancelled: "已取消",
  transferring: "正在打开表单…",
  transferred: "已转到表单",
  expired: "已失效",
};

export function ProposalCard({ id, store }: { id: string; store: AiStore }) {
  const proposal = store((state) => state.proposals[id]);
  if (!proposal) return <p className="ai-message-note">此操作卡片已失效，请重新说明。</p>;
  const action = store.getState().getProposalAction(id);
  const Preview = action?.Preview;
  const label = createLabels[proposal.actionName] ?? { title: "操作提案", icon: "待" };
  const editable = proposal.status === "pending" || proposal.status === "failed";
  const busy = proposal.status === "saving" || proposal.status === "transferring";
  const deleting = proposal.actionName.includes("delete");
  const creating = ["calendar_create_event", "reminders_create", "memos_create"].includes(
    proposal.actionName,
  );
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
          {...(proposal.scope ? { scope: proposal.scope } : {})}
        />
      ) : (
        <p className="text-destructive">此操作当前不可用，请重新发起或手动新建。</p>
      )}
      {proposal.selections && (
        <fieldset disabled={!editable} className="space-y-2">
          <legend>选择要删除的项目（已选 {proposal.selectedIds.length} 项）</legend>
          {proposal.selections.map((item) => (
            <label key={item.id} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={proposal.selectedIds.includes(item.id)}
                onChange={(event) =>
                  store
                    .getState()
                    .selectProposal(
                      id,
                      event.target.checked
                        ? [...proposal.selectedIds, item.id]
                        : proposal.selectedIds.filter((value) => value !== item.id),
                    )
                }
              />
              <span>
                {item.when} · {item.title}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {proposal.needsScope && (
        <fieldset disabled={!editable} className="space-y-2">
          <legend>重复日程的操作范围（请选择）</legend>
          {(
            [
              { value: "this", label: "仅这次" },
              { value: "following", label: "这次及以后" },
              { value: "all", label: "全部" },
            ] as const
          ).map((option) => (
            <label key={option.value} className="mr-4 inline-flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`scope-${id}`}
                value={option.value}
                checked={proposal.scope === option.value}
                onChange={() => store.getState().setProposalScope(id, option.value)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
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
            variant={deleting ? "destructive" : "default"}
            disabled={
              busy ||
              !Preview ||
              (proposal.needsScope && !proposal.scope) ||
              Boolean(proposal.selections && !proposal.selectedIds.length)
            }
            onClick={() => void store.getState().confirmProposal(id)}
          >
            {proposal.status === "saving"
              ? "正在保存…"
              : proposal.status === "failed"
                ? "重试保存"
                : deleting
                  ? proposal.selections
                    ? `确认删除 ${proposal.selectedIds.length} 项`
                    : "确认删除"
                  : "确认"}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => store.getState().cancelProposal(id)}
          >
            取消
          </Button>
          {creating && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void store.getState().transferProposal(id)}
            >
              {proposal.status === "transferring" ? "正在打开表单…" : "在表单中打开"}
            </Button>
          )}
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
