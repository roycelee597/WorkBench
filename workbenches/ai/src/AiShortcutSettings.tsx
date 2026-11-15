import { useEffect, useState } from "react";
import { Button } from "@workbench/ui";
import type { ShortcutStatus } from "../../../apps/desktop/src/core/shortcut-controller";
import { DEFAULT_AI_SHORTCUT } from "../../../apps/desktop/src/core/shortcut-controller";
import type { AiApi } from "./api";

export function AiShortcutSettings({ api }: { api: AiApi }) {
  const [value, setValue] = useState(DEFAULT_AI_SHORTCUT);
  const [status, setStatus] = useState<ShortcutStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void api
      .getGlobalShortcut()
      .then((current) => {
        if (live) {
          setStatus(current);
          setValue(current.configured);
        }
      })
      .catch((failure: unknown) => {
        if (live)
          setError(failure instanceof Error ? failure.message : "AI 快捷键读取失败，请重试");
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [api]);
  return (
    <form
      className="space-y-3 border-t border-border pt-3"
      aria-labelledby="ai-shortcut-heading"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          const next = await api.setGlobalShortcut(value);
          setStatus(next);
          setValue(next.configured);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : "AI 快捷键保存失败，请重试");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <h3 className="font-medium" id="ai-shortcut-heading">
          AI 助手快捷键
        </h3>
        <p className="text-muted-foreground">
          窗口藏在托盘时也能呼出并聚焦输入框；Space 需同时配合 Ctrl+Alt 或 Ctrl+Shift。
        </p>
      </div>
      <label className="event-field">
        快捷键
        <input
          aria-label="AI 助手快捷键"
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          placeholder={DEFAULT_AI_SHORTCUT}
        />
      </label>
      <div className="shortcut-actions">
        <span>{status?.active ? `当前生效：${status.active}` : "尚未注册成功"}</span>
        <Button type="submit" disabled={busy}>
          {busy ? "正在注册…" : "保存 / 重试 AI 快捷键"}
        </Button>
      </div>
      {(error || status?.error) && (
        <p role="alert" className="text-destructive">
          {error || status?.error}
        </p>
      )}
    </form>
  );
}
