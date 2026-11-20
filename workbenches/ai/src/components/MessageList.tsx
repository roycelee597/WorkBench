import { useEffect, useRef } from "react";
import type { AiMessage, AiStore } from "../ai-store";
import { ErrorCard } from "./ErrorCard";
import { CandidateCard } from "./CandidateCard";
import { ReadResults, ReferencedText } from "./ReadResults";

export function MessageList({
  messages,
  activity,
  openSettings,
  manualCreate,
  openPlatform,
  store,
}: {
  messages: AiMessage[];
  activity: string;
  openSettings: () => void;
  manualCreate: () => void;
  openPlatform: () => void;
  store: AiStore;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const navigationErrors = store((state) => state.navigationErrors);
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, activity]);
  return (
    <div className="ai-message-list" role="log" aria-label="与 AI 助手的对话" aria-live="polite">
      {messages.map((message) => {
        if (message.role === "user")
          return (
            <article className="ai-message ai-user-message" key={message.id}>
              <span className="ai-message-author">你</span>
              <p>{message.text}</p>
            </article>
          );
        const event = message.event;
        return (
          <article className="ai-message ai-assistant-message" key={message.id}>
            <span className="ai-message-author">AI 助手</span>
            {event.type === "error" ? (
              <ErrorCard
                error={event}
                openSettings={openSettings}
                manualCreate={manualCreate}
                openPlatform={openPlatform}
                {...(event.target
                  ? {
                      openTarget: () =>
                        void store.getState().openLocalTarget(event.target!, message.id),
                    }
                  : {})}
              />
            ) : event.type === "text" ? (
              <ReferencedText text={event.text} store={store} />
            ) : event.type === "warning" ? (
              <p className="ai-message-note">{event.message}</p>
            ) : event.type === "results" ? (
              <ReadResults items={event.items} empty={event.empty} store={store} />
            ) : event.prepared.type === "proposal" || event.prepared.type === "choose" ? (
              <CandidateCard id={message.id} store={store} />
            ) : (
              <p className="ai-message-note">已生成操作提案，尚未保存。</p>
            )}
            {navigationErrors[message.id] && (
              <p className="text-sm text-destructive" role="alert">
                {navigationErrors[message.id]}
              </p>
            )}
          </article>
        );
      })}
      {activity && (
        <p className="ai-activity" role="status">
          {activity}
        </p>
      )}
      <div ref={bottom} />
    </div>
  );
}
