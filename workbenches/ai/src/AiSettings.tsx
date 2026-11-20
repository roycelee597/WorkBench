import { useEffect, useRef, useState } from "react";
import { Button } from "@workbench/ui";
import { aiApi, type AiApi } from "./api";
import { AiShortcutSettings } from "./AiShortcutSettings";
import { AiLimitsSettings } from "./AiLimitsSettings";
import {
  aiError,
  aiModelSchema,
  type AiKeyStatus,
  type AiModel,
  DEFAULT_AI_MODEL,
} from "../../../apps/desktop/src/core/ai/llm-client";

export function AiSettings({ api = aiApi }: { api?: AiApi } = {}) {
  const [status, setStatus] = useState<AiKeyStatus | null>(null);
  const [model, setModel] = useState<AiModel>(DEFAULT_AI_MODEL);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");
  const working = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([api.keyStatus(), api.loadModel()])
      .then(([key, selected]) => {
        if (live) {
          setStatus(key);
          setModel(selected);
        }
      })
      .catch((error: unknown) => {
        if (live) setFailure(aiError(error).message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api]);

  async function act(action: () => Promise<void>, success = "") {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setFailure("");
    setMessage("");
    try {
      await action();
      setMessage(success);
    } catch (error) {
      setFailure(aiError(error).message);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="settings-section space-y-4" aria-labelledby="ai-settings-heading">
      <div>
        <h2 id="ai-settings-heading">AI 助手</h2>
        <p>DeepSeek API key 仅保存在本机 Windows 凭据管理器中，保存后只显示末 4 位。</p>
      </div>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || loading || !input.current) return;
          const key = input.current.value;
          input.current.value = "";
          void act(async () => {
            setStatus(await api.saveKey(key));
          }, "已保存 API key");
        }}
      >
        <label className="event-field">
          DeepSeek API key
          <input
            ref={input}
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
            disabled={busy || loading}
          />
        </label>
        <p className="text-muted-foreground">
          {status?.configured
            ? `已设置（尾号 ${status.tail}）`
            : loading
              ? "正在读取凭据状态…"
              : status
                ? "尚未设置"
                : "无法读取凭据状态，请重试"}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || loading}>
            保存
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || loading || !status?.configured}
            onClick={() => void act(api.testKey, "连接正常")}
          >
            测试连接
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || loading || status?.configured === false}
            onClick={() =>
              void act(async () => {
                await api.clearKey();
                if (input.current) input.current.value = "";
                setStatus((previous) =>
                  previous ? { ...previous, configured: false, tail: null } : previous,
                );
                setStatus(await api.keyStatus());
              }, "已清除 API key")
            }
          >
            清除
          </Button>
        </div>
      </form>
      <p className="text-muted-foreground">
        在{" "}
        <button
          type="button"
          className="underline"
          disabled={busy}
          onClick={() => void act(api.openPlatform)}
        >
          DeepSeek 开放平台
        </button>{" "}
        申请 API key，链接会在系统浏览器打开。
      </p>
      <label className="event-field">
        模型
        <select
          value={model}
          disabled={busy || loading}
          onChange={(event) => {
            const next = aiModelSchema.safeParse(event.target.value);
            if (next.success)
              void act(async () => {
                await api.saveModel(next.data);
                setModel(next.data);
              }, "已保存模型设置");
          }}
        >
          <option value="deepseek-flash">deepseek-flash（默认，快速）</option>
          <option value="deepseek-v4-pro">deepseek-v4-pro</option>
        </select>
      </label>
      <div className="space-y-2 border-t border-border pt-3">
        <h3 className="font-medium">今日用量（北京时间）</h3>
        <p>
          {status
            ? `${status.usage.date} · 已调用 ${status.usage.calls} 次 · 输入 ${status.usage.prompt_tokens} / 输出 ${status.usage.completion_tokens} token`
            : "暂未读取用量"}
        </p>
        <p className="text-muted-foreground">
          请求发出后即计数，失败和超时也会计入。测试连接不计模型调用。
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={busy || loading}
          onClick={() =>
            void act(async () => {
              setStatus(await api.keyStatus());
            })
          }
        >
          刷新用量 / 重试
        </Button>
      </div>
      {busy && <p role="status">正在处理…</p>}
      {message && <p role="status">{message}</p>}
      {failure && (
        <p className="text-destructive" role="alert">
          {failure}
        </p>
      )}
      <AiShortcutSettings api={api} />
      <AiLimitsSettings api={api} />
    </section>
  );
}
