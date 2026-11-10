import { Button } from "@workbench/ui";
import { useState } from "react";
import { displayFinanceError, financeApi, useFinanceState, useFinanceUpdate } from "./api";
import { FinanceDashboard } from "./FinanceDashboard";

const stages = {
  calendar: "交易日历",
  stock_basic: "证券目录",
  index: "指数数据",
  recent: "近期行情",
  backfill: "历史数据",
  compute: "计算指标",
};

export function FinanceWorkbench({ openSettings }: { openSettings: () => void }) {
  const update = useFinanceUpdate();
  const token = useFinanceState((state) => state.token);
  const runtimeError = useFinanceState((state) => state.error);
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = update.status === "running" || update.status === "already_running";
  const text = busy
    ? update.stage
      ? `正在更新${stages[update.stage]}`
      : "正在准备更新"
    : update.status === "complete"
      ? "已是最新"
      : update.status === "partial"
        ? "部分数据待补齐"
        : update.status === "failed"
          ? "更新失败"
          : "等待更新";
  const detail = update.diagnostic?.message ?? runtimeError ?? actionError;
  const progress = update.progress;

  return (
    <section className="general-workbench" aria-label="金融指标工作台">
      <header className="workspace-header">
        <div>
          <span className="workspace-eyebrow">我的工作空间 / 金融指标</span>
          <h1>金融指标</h1>
        </div>
      </header>
      <div className="workspace-panel space-y-4 p-6">
        <section className="rounded-xl border border-border bg-card p-5" role="status">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <strong>{text}</strong>
            {busy && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setActionError(null);
                  void financeApi
                    .cancelUpdate()
                    .catch((error: unknown) => setActionError(displayFinanceError(error)));
                }}
              >
                停止更新
              </Button>
            )}
          </div>
          {progress && (
            <>
              <p className="mt-2 text-muted-foreground">
                {progress.done}/{progress.total} 天，预计还需 {Math.ceil(progress.eta_seconds / 60)}{" "}
                分钟
              </p>
              <progress
                className="mt-3 w-full"
                aria-label="更新进度"
                value={progress.done}
                max={Math.max(1, progress.total)}
              />
            </>
          )}
          {detail && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p
                className={
                  update.status === "failed" ? "text-destructive" : "text-muted-foreground"
                }
              >
                {detail}
              </p>
              <Button variant="outline" size="sm" onClick={openSettings}>
                去设置
              </Button>
            </div>
          )}
        </section>
        <FinanceDashboard
          api={financeApi}
          revision={update.revision}
          busy={busy}
          configured={token?.configured ?? false}
          update={() => void financeApi.requestUpdate()}
          openSettings={openSettings}
        />
      </div>
    </section>
  );
}
