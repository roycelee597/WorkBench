import { Button, Dialog } from "@workbench/ui";
import { useState } from "react";
import {
  displayFinanceError,
  financeApi,
  useFinanceCache,
  useFinanceState,
  useFinanceUpdate,
} from "./api";

const stages = {
  calendar: "交易日历",
  stock_basic: "证券目录",
  index: "指数数据",
  recent: "近期行情",
  backfill: "历史数据",
  compute: "计算指标",
};

export function financeDate(day: number | null | undefined): string {
  if (!day) return "—";
  const value = String(day);
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
}

export function FinanceWorkbench({ openSettings }: { openSettings: () => void }) {
  const { status, error } = useFinanceCache();
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
  const detail = update.diagnostic?.message ?? runtimeError ?? error ?? actionError;
  const progress = update.progress;

  return (
    <section className="general-workbench" aria-label="金融指标工作台">
      <header className="workspace-header">
        <div>
          <span className="workspace-eyebrow">我的工作空间 / 金融指标</span>
          <h1>金融指标</h1>
          <p className="mt-1 text-muted-foreground">数据截至 {financeDate(status?.latestDate)}</p>
        </div>
        <Button
          disabled={busy || !token?.configured}
          onClick={() => void financeApi.requestUpdate()}
        >
          {busy ? "更新中…" : "立即更新"}
        </Button>
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
                  update.status === "failed" || error ? "text-destructive" : "text-muted-foreground"
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
        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold">{token?.configured ? "指标概览" : "连接 Tushare"}</h2>
          <p className="mt-2 text-muted-foreground">
            {token?.configured
              ? "这里可以查看本地金融数据的更新状态。"
              : "先在 设置 → 金融指标 填写 Tushare token。"}
          </p>
          {!token?.configured && (
            <Button className="mt-4" variant="outline" onClick={openSettings}>
              去设置
            </Button>
          )}
        </section>
      </div>
    </section>
  );
}

export function FinanceBackfillDialog() {
  const open = useFinanceState((state) => state.confirmBackfill);
  const error = useFinanceState((state) => state.error);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) financeApi.dismissBackfill();
      }}
      title="开始首次回补？"
      description="需要下载个股 2015 年至今、指数估值 2005 年至今的数据，约 6000–8700 次请求，预计 35–50 分钟。期间可以正常使用，关掉 App 下次会继续。"
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={financeApi.dismissBackfill}>
            稍后
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await financeApi.approveBackfill();
              } finally {
                setBusy(false);
              }
            }}
          >
            开始
          </Button>
        </>
      }
    >
      {error && (
        <p className="mt-3 text-destructive" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
