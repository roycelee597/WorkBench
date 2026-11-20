import { useEffect, useRef, useState } from "react";
import { Button } from "@workbench/ui";
import {
  aiCallLimitsSchema,
  aiError,
  type AiCallLimits,
} from "../../../apps/desktop/src/core/ai/llm-client";
import type { AiApi } from "./api";
import { aiReadPolicy } from "./ai-preferences";

const readDisableFailure = "已在当前进程关闭读取。设置未写入，请点击重试保存关闭设置。";

export function AiLimitsSettings({ api }: { api: AiApi }) {
  const [limits, setLimits] = useState<AiCallLimits | null>(null);
  const [daily, setDaily] = useState("");
  const [minute, setMinute] = useState("");
  const [read, setRead] = useState<boolean | null>(null);
  const [steps, setSteps] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let live = true;
    void api
      .loadCallLimits()
      .then((value) => {
        if (!live) return;
        setLimits(value);
        setDaily(String(value.daily));
        setMinute(String(value.per_minute));
      })
      .catch(() => {
        if (live) setError("无法读取调用限额，请重试。");
      });
    void api
      .loadReadEnabled()
      .then((value) => {
        if (live) setRead(value);
      })
      .catch(() => {
        if (live) setError("无法读取 AI 数据设置，请重试。");
      });
    void api
      .loadStepLimitEnabled()
      .then((value) => {
        if (live) setSteps(value);
      })
      .catch(() => {
        if (live) setError("无法读取 AI 步数设置，请重试。");
      });
    return () => {
      live = false;
    };
  }, [api, retry]);

  async function save(action: () => Promise<void>, failure: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage("已保存 AI 设置");
    } catch {
      setError(failure);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function saveLimits(enabled: boolean) {
    if (!limits) return;
    const parsed = aiCallLimitsSchema.safeParse(
      enabled
        ? { enabled, daily: Number(daily), per_minute: Number(minute) }
        : { ...limits, enabled },
    );
    if (!parsed.success) {
      setError("每日和每分钟上限须为 1–4294967295 的整数。");
      return;
    }
    void save(async () => {
      const value = await api.saveCallLimits(parsed.data);
      setLimits(value);
      setDaily(String(value.daily));
      setMinute(String(value.per_minute));
    }, "无法保存调用限额，请重试。");
  }

  function saveRead(value: boolean) {
    void save(
      async () => {
        if (!value) setRead(false);
        try {
          await api.saveReadEnabled(value);
          setRead(value);
        } catch (failure) {
          setRead(aiReadPolicy.isAllowed());
          throw failure;
        }
      },
      value ? "无法开启读取，请重试。" : readDisableFailure,
    );
  }

  return (
    <div className="space-y-4 border-t border-border pt-3">
      <label className="event-all-day">
        <input
          type="checkbox"
          checked={read === true}
          disabled={busy || read === null}
          onChange={(event) => saveRead(event.target.checked)}
        />
        允许 AI 读取日程和提醒
      </label>
      {error === readDisableFailure && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => saveRead(false)}
        >
          重试保存关闭设置
        </Button>
      )}
      <div className="space-y-1 text-muted-foreground">
        <p>每次发送你这次说的话、最近几句对话、当前日期时间和时区，以及可用操作的说明。</p>
        <p>
          开启读取后，AI
          按需发送日程和提醒的标题、时间、是否全天、重复说明、提前提醒、优先级、完成状态和来源。每次最多
          366 天、500 条、30,000 字符，读取时对话里会显示“正在查看…”。
        </p>
        <p>
          不会读取或发送已存日程和提醒的备注、备忘录标题和正文、真实记录 ID 或设备信息。API key
          仅用于请求鉴权。
        </p>
        <p>
          发送的内容由 DeepSeek 按其隐私政策处理。{" "}
          <button
            className="underline"
            type="button"
            onClick={() =>
              void api
                .openPrivacyPolicy()
                .catch((failure: unknown) => setError(aiError(failure).message))
            }
          >
            DeepSeek 开放平台隐私政策
          </button>
        </p>
      </div>
      <label className="event-all-day">
        <input
          type="checkbox"
          checked={steps === true}
          disabled={busy || steps === null}
          onChange={(event) => {
            const value = event.target.checked;
            void save(async () => {
              await api.saveStepLimitEnabled(value);
              setSteps(value);
            }, "无法保存 AI 步数设置，请重试。");
          }}
        />
        限制每条消息的 AI 步数
      </label>
      <p className="text-muted-foreground">
        启用时最多 6 步。关闭后仍会在 20 步停止，以免循环继续。
      </p>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          saveLimits(true);
        }}
      >
        <label className="event-all-day">
          <input
            type="checkbox"
            checked={limits?.enabled === true}
            disabled={busy || !limits}
            onChange={(event) => saveLimits(event.target.checked)}
          />
          启用调用限额
        </label>
        <p className="text-muted-foreground">
          默认关闭。用量始终计数，启用时由桌面应用按下列上限拦截。
        </p>
        {limits?.enabled && (
          <>
            <div className="event-field-row">
              <label className="event-field">
                每日上限
                <input
                  type="number"
                  required
                  min={1}
                  max={4_294_967_295}
                  step={1}
                  value={daily}
                  disabled={busy}
                  onChange={(event) => setDaily(event.target.value)}
                />
              </label>
              <label className="event-field">
                每分钟上限
                <input
                  type="number"
                  required
                  min={1}
                  max={4_294_967_295}
                  step={1}
                  value={minute}
                  disabled={busy}
                  onChange={(event) => setMinute(event.target.value)}
                />
              </label>
            </div>
            <Button type="submit" variant="outline" disabled={busy}>
              保存调用限额
            </Button>
          </>
        )}
      </form>
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
      {(limits === null || read === null || steps === null) && error && (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setError("");
            setRetry(retry + 1);
          }}
        >
          重新读取 AI 设置
        </Button>
      )}
    </div>
  );
}
