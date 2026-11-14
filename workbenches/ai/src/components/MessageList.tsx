import { useEffect, useRef } from "react";
import type { AiMessage } from "../ai-store";
import { ErrorCard } from "./ErrorCard";

export function MessageList({
  messages,
  activity,
  openSettings,
  manualCreate,
  openPlatform,
}: {
  messages: AiMessage[];
  activity: string;
  openSettings: () => void;
  manualCreate: () => void;
  openPlatform: () => void;
}) {
  const bottom = useRef<HTMLDivElement>(null);
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
              />
            ) : event.type === "text" ? (
              <p>{event.text}</p>
            ) : event.type === "warning" ? (
              <p className="ai-message-note">{event.message}</p>
            ) : event.type === "results" ? (
              <div>
                <p>{event.items.length ? "查到的内容" : event.empty}</p>
                <ul>
                  {event.items.map((item) => (
                    <li key={item.id}>
                      {item.when} · {item.title}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="ai-message-note">已生成操作提案，尚未保存。</p>
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
