import { useRef, useState } from "react";
import { Button } from "@workbench/ui";
import {
  quickInputSchema,
  type QuickInput,
} from "../../../../apps/desktop/src/core/quick-create-contract";
import { parseLocal, timeInZone, shiftDay } from "../calendar-model";

export function QuickCreateForm({
  onSave,
  onClose,
  onBusy,
  onDirty,
}: {
  onSave: (input: QuickInput) => Promise<void>;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  onDirty?: () => void;
}) {
  const [type, setType] = useState<QuickInput["type"]>("memo");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [zone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [start, setStart] = useState(() => timeInZone(Date.now() + 3_600_000, zone));
  const [end, setEnd] = useState(() => timeInZone(Date.now() + 7_200_000, zone));
  const [timed, setTimed] = useState(false);
  const [allDay, setAllDay] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writing = useRef(false);
  async function save() {
    if (writing.current) return;
    setError(null);
    try {
      const value: QuickInput =
        type === "memo"
          ? { type, title, content: body }
          : type === "reminder"
            ? {
                type,
                title,
                notes: body,
                due_at: timed ? parseLocal(start, zone) : null,
                timezone: zone,
              }
            : {
                type,
                title,
                notes: body,
                timezone: zone,
                all_day: allDay,
                start_at: parseLocal(allDay ? start.slice(0, 10) : start, zone),
                end_at: parseLocal(allDay ? shiftDay(end.slice(0, 10), 1) : end, zone),
              };
      const parsed = quickInputSchema.safeParse(value);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "请检查输入");
      writing.current = true;
      setBusy(true);
      onBusy(true);
      await onSave(parsed.data);
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败，请重试。");
    } finally {
      writing.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <form
      className="quick-form"
      onChange={() => onDirty?.()}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          !event.defaultPrevented &&
          !event.shiftKey &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229 &&
          !(event.target instanceof HTMLSelectElement) &&
          !(event.target instanceof HTMLButtonElement)
        ) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
    >
      <div className="quick-types" role="group" aria-label="快速新建类型">
        {[
          { value: "memo", label: "备忘" },
          { value: "event", label: "日程" },
          { value: "reminder", label: "提醒" },
        ].map((choice) => (
          <Button
            type="button"
            key={choice.value}
            disabled={busy}
            aria-pressed={type === choice.value}
            variant={type === choice.value ? "default" : "outline"}
            onClick={() => {
              onDirty?.();
              setType(choice.value as QuickInput["type"]);
            }}
          >
            {choice.label}
          </Button>
        ))}
      </div>
      <fieldset disabled={busy}>
        <label className="event-field">
          标题
          <input
            autoFocus
            value={title}
            maxLength={200}
            placeholder="记下一件重要的小事"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="event-field">
          {type === "memo" ? "正文（Markdown）" : "备注"}
          <textarea
            rows={type === "memo" ? 6 : 3}
            value={body}
            maxLength={20000}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        {type === "event" && (
          <label className="event-all-day">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(event) => setAllDay(event.target.checked)}
            />
            全天
          </label>
        )}
        {type === "reminder" && (
          <label className="event-all-day">
            <input
              type="checkbox"
              checked={timed}
              onChange={(event) => setTimed(event.target.checked)}
            />
            设置到期时间
          </label>
        )}
        {(type === "event" || (type === "reminder" && timed)) && (
          <div className="event-field-row">
            <label className="event-field">
              {type === "event" ? "开始" : "到期时间"}
              <input
                type={allDay && type === "event" ? "date" : "datetime-local"}
                required
                value={allDay && type === "event" ? start.slice(0, 10) : start}
                onChange={(event) =>
                  setStart(
                    event.target.value.length === 10
                      ? `${event.target.value}T00:00`
                      : event.target.value,
                  )
                }
              />
            </label>
            {type === "event" && (
              <label className="event-field">
                {allDay ? "结束日期（含当天）" : "结束"}
                <input
                  required
                  type={allDay ? "date" : "datetime-local"}
                  value={allDay ? end.slice(0, 10) : end}
                  onChange={(event) =>
                    setEnd(
                      event.target.value.length === 10
                        ? `${event.target.value}T00:00`
                        : event.target.value,
                    )
                  }
                />
              </label>
            )}
          </div>
        )}
        {type === "event" && (
          <p className="quick-hint">提前提醒使用设置中的默认值；更多选项可在日程页调整。</p>
        )}
        {type === "reminder" && !timed && (
          <p className="quick-hint">未设置时间时保存为普通待办。</p>
        )}
      </fieldset>
      {error && (
        <p className="event-form-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <small>Enter 保存 · Shift+Enter 换行 · Esc 关闭</small>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          关闭
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "正在保存…" : "保存"}
        </Button>
      </footer>
    </form>
  );
}
