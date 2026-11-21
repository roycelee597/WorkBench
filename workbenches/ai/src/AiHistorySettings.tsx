import { useEffect, useState } from "react";
import { Button } from "@workbench/ui";
import type { AiApi } from "./api";
import { useAiStore, type AiStore } from "./ai-store";
import { ClearHistoryDialog } from "./components/ClearHistoryDialog";

export function AiHistorySettings({ api, store = useAiStore }: { api: AiApi; store?: AiStore }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const busy = store((state) => state.pending || state.proposalBusy || state.clearingHistory);

  useEffect(() => {
    let active = true;
    void api.loadHistoryEnabled().then(
      (value) => {
        if (active) setEnabled(value);
      },
      () => {
        if (active) setError("无法读取对话记录设置，请重试。");
      },
    );
    return () => {
      active = false;
    };
  }, [api, retry]);

  async function save(value: boolean) {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      await api.saveHistoryEnabled(value);
      setEnabled(value);
      setMessage("已保存对话记录设置");
    } catch {
      setError("无法保存对话记录设置，请重试。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <label className="event-all-day">
        <input
          type="checkbox"
          checked={enabled === true}
          disabled={loading || enabled === null}
          onChange={(event) => void save(event.target.checked)}
        />
        保存对话记录
      </label>
      <p className="text-muted-foreground">
        对话只保存在本机，显示最近 200 条，30
        天前的内容会自动清空。关闭后停止保存，已有记录可手动清空。
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={busy || loading}
        onClick={() => {
          setMessage("");
          setConfirm(true);
        }}
      >
        清空对话记录
      </Button>
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {enabled === null && error && (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setError("");
            setRetry(retry + 1);
          }}
        >
          重新读取对话记录设置
        </Button>
      )}
      <ClearHistoryDialog
        store={store}
        open={confirm}
        setOpen={setConfirm}
        onCleared={() => setMessage("已清空对话记录")}
      />
    </div>
  );
}
