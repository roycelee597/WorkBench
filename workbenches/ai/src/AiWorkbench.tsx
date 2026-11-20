import { useEffect, useRef, useState } from "react";
import { Button } from "@workbench/ui";
import { useAiStore, type AiStore } from "./ai-store";
import { aiApi } from "./api";
import { aiError } from "../../../apps/desktop/src/core/ai/llm-client";
import { Composer } from "./components/Composer";
import { MessageList } from "./components/MessageList";
import { ErrorCard } from "./components/ErrorCard";

const examples = [
  "明天下午三点提醒我交实验报告",
  "明天有什么安排",
  "这周还有哪些没完成的提醒",
  "记一下：实验室门禁找张老师",
];

export function AiWorkbench({
  openSettings,
  manualCreate,
  focusVersion,
  store = useAiStore,
}: {
  openSettings: () => void;
  manualCreate: () => void;
  focusVersion: number;
  store?: AiStore;
}) {
  const state = store();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [platformError, setPlatformError] = useState("");
  const refresh = state.refresh;
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    textarea.current?.focus({ preventScroll: true });
  }, [focusVersion]);
  function openPlatform() {
    void aiApi.openPlatform().catch((error: unknown) => setPlatformError(aiError(error).message));
  }
  return (
    <section className="ai-workbench" aria-label="AI 助手工作台">
      <header className="workspace-header ai-workbench-header">
        <div>
          <span className="workspace-eyebrow">
            我的工作空间 <span>/</span> AI 助手
          </span>
          <h1>AI 助手</h1>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            disabled={state.pending || state.proposalBusy || !state.messages.length}
            onClick={state.clear}
          >
            清空对话
          </Button>
          <Button variant="outline" onClick={openSettings}>
            设置
          </Button>
        </div>
      </header>
      <div className="ai-chat-surface">
        {state.connectionError && (
          <ErrorCard
            error={state.connectionError}
            openSettings={openSettings}
            manualCreate={manualCreate}
            openPlatform={openPlatform}
          />
        )}
        {state.key?.configured === false && (
          <div className="ai-key-guide">
            <div>
              <strong>先连接你的 AI 助手</strong>
              <p>先在 设置 → AI 助手 填写 DeepSeek API key。</p>
            </div>
            <Button variant="outline" size="sm" onClick={openSettings}>
              去设置
            </Button>
          </div>
        )}
        {!state.messages.length ? (
          <div className="ai-welcome">
            <span className="ai-welcome-mark" aria-hidden="true">
              ✦
            </span>
            <h2>从一句话开始</h2>
            <p>查询安排，或提出修改；所有写入都要核对卡片并确认。</p>
            <div className="ai-examples">
              {examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => {
                    state.setDraft(example);
                    textarea.current?.focus();
                  }}
                >
                  {example}
                  <span aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <MessageList
            store={store}
            messages={state.messages}
            activity={state.activity}
            openSettings={openSettings}
            manualCreate={manualCreate}
            openPlatform={openPlatform}
          />
        )}
        {platformError && (
          <p role="alert" className="text-destructive">
            {platformError}
          </p>
        )}
        {state.connectionError && (
          <Button
            className="self-start"
            size="sm"
            variant="outline"
            disabled={state.checking}
            onClick={() => void state.refresh()}
          >
            重新读取设置
          </Button>
        )}
        <Composer
          value={state.draft}
          onChange={state.setDraft}
          send={() => void state.send()}
          disabled={state.pending || state.checking || !state.key?.configured}
          pending={state.pending}
          activity={state.activity}
          inputRef={textarea}
        />
        <p className="ai-disclaimer">
          {state.checking ? "正在读取设置…" : `当前模型：${state.model}`} · AI
          可能理解有误，请核对回复。
        </p>
      </div>
    </section>
  );
}
