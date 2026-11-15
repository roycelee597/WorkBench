import { useRef, type RefObject } from "react";
import { Button } from "@workbench/ui";

export function Composer({
  value,
  onChange,
  send,
  disabled,
  pending,
  activity,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  send: () => void;
  disabled: boolean;
  pending: boolean;
  activity: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const composing = useRef(false);
  const length = Array.from(value).length;
  return (
    <form
      className="ai-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && value.trim() && length <= 1_000) send();
      }}
    >
      <label htmlFor="ai-composer" className="sr-only">
        给 AI 助手发送消息
      </label>
      <textarea
        id="ai-composer"
        ref={inputRef}
        value={value}
        rows={3}
        maxLength={2_000}
        placeholder="说说你想了解什么…"
        onChange={(event) => onChange(event.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !composing.current &&
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229
          ) {
            event.preventDefault();
            if (!disabled && value.trim() && length <= 1_000) send();
          }
        }}
      />
      <div className="ai-composer-footer">
        <span>{pending ? activity || "正在理解…" : "Enter 发送 · Shift+Enter 换行"}</span>
        <span className={length > 1_000 ? "text-destructive" : ""}>{length} / 1000</span>
        <Button type="submit" disabled={disabled || !value.trim() || length > 1_000}>
          {pending ? "正在理解…" : "发送"}
        </Button>
      </div>
    </form>
  );
}
