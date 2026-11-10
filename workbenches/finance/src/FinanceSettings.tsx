import { useState } from "react";
import { Button, Dialog } from "@workbench/ui";
import {
  displayFinanceError,
  financeApi,
  useFinanceCache,
  useFinanceState,
  useFinanceUpdate,
} from "./api";
import { financeDate } from "./series-view";

export function FinanceSettings() {
  const [value, setValue] = useState("");
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");
  const [working, setWorking] = useState(false);
  const [rebuild, setRebuild] = useState(false);
  const token = useFinanceState((state) => state.token);
  const runtimeError = useFinanceState((state) => state.error);
  const { status, error } = useFinanceCache();
  const update = useFinanceUpdate();
  const busy = working || update.status === "running" || update.status === "already_running";

  async function act(action: () => Promise<void>, success = "") {
    setWorking(true);
    setFailure("");
    setMessage("");
    try {
      await action();
      setMessage(success);
    } catch (error) {
      setFailure(displayFinanceError(error));
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="settings-section space-y-4" aria-labelledby="finance-settings-heading">
      <div>
        <h2 id="finance-settings-heading">金融指标</h2>
        <p>使用本机系统凭据保存 Tushare token。</p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && value.trim())
            void act(async () => {
              await financeApi.saveToken(value);
              setValue("");
            }, "已保存凭据");
        }}
      >
        <label className="event-field">
          Tushare token
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={busy}
          />
        </label>
        <p className="text-muted-foreground">
          {token?.configured
            ? `已设置${token.tail ? `（尾号 ${token.tail}）` : ""}`
            : token
              ? "尚未设置"
              : "正在读取凭据状态"}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !value.trim()}>
            保存
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !token?.configured}
            onClick={() => void act(financeApi.verify, "连接正常，积分满足要求")}
          >
            测试连接
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !token?.configured}
            onClick={() =>
              void act(async () => {
                await financeApi.clearToken();
                setValue("");
              }, "已清除凭据")
            }
          >
            清除
          </Button>
        </div>
      </form>
      <div className="space-y-2 border-t border-border pt-3">
        <h3 className="font-medium">数据状态</h3>
        <p>
          最早 {financeDate(status?.firstDate)} · 最新 {financeDate(status?.latestDate)} ·{" "}
          {((status?.bytes ?? 0) / 1024 / 1024).toFixed(1)} MiB
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={working}
            onClick={() => void act(financeApi.openDirectory)}
          >
            打开数据文件夹
          </Button>
          <Button
            variant="outline"
            disabled={busy || !token?.configured}
            onClick={() => setRebuild(true)}
          >
            重建金融数据
          </Button>
        </div>
      </div>
      {message && <p role="status">{message}</p>}
      {(failure || runtimeError || error || update.diagnostic?.message) && (
        <p className="text-destructive" role="alert">
          {failure || runtimeError || error || update.diagnostic?.message}
        </p>
      )}
      <Dialog
        open={rebuild}
        onOpenChange={setRebuild}
        title="重建金融数据？"
        description="这会重建本地金融行情缓存，预计需要 35–50 分钟。备忘录、日程和提醒将保留。"
        footer={
          <>
            <Button variant="outline" onClick={() => setRebuild(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setRebuild(false);
                void act(() => financeApi.requestUpdate("full-rebuild"));
              }}
            >
              确认重建
            </Button>
          </>
        }
      />
    </section>
  );
}
