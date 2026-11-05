import { Button } from "@workbench/ui";
import { Check } from "lucide-react";
import {
  eventColors,
  reminderChoices,
  repeatChoices,
  toggleAllDay,
  type EventDraft,
  type RepeatPreset,
} from "../calendar-model";

export function EventForm({
  draft,
  onChange,
  onSubmit,
  busy,
}: {
  draft: EventDraft;
  onChange: (draft: EventDraft) => void;
  onSubmit: () => void;
  busy: boolean;
}) {
  const set = (patch: Partial<EventDraft>) => onChange({ ...draft, ...patch });
  const repeat = (patch: Partial<EventDraft["repeat"]>) =>
    set({ repeat: { ...draft.repeat, ...patch } });
  return (
    <form
      id="event-form"
      className="event-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <fieldset disabled={busy}>
        <label className="event-field">
          标题
          <input
            autoFocus
            required
            value={draft.title}
            placeholder="为这段时间起个名字"
            onChange={(event) => set({ title: event.target.value })}
          />
        </label>
        <label className="event-all-day">
          <input
            type="checkbox"
            checked={draft.allDay}
            onChange={(event) => onChange(toggleAllDay(draft, event.target.checked))}
          />
          全天日程
        </label>
        <div className="event-field-row">
          <label className="event-field">
            开始
            <input
              required
              type={draft.allDay ? "date" : "datetime-local"}
              value={draft.start}
              onChange={(event) => set({ start: event.target.value })}
            />
          </label>
          <label className="event-field">
            结束{draft.allDay && "（含当天）"}
            <input
              required
              type={draft.allDay ? "date" : "datetime-local"}
              value={draft.end}
              onChange={(event) => set({ end: event.target.value })}
            />
          </label>
        </div>
        <p className="event-zone">日程时区：{draft.zone}；日历中的时间按本机时区显示。</p>
        <label className="event-field">
          备注
          <textarea
            rows={2}
            value={draft.notes}
            placeholder="地点、准备事项或其他细节"
            onChange={(event) => set({ notes: event.target.value })}
          />
        </label>
        <div className="event-field">
          <span>颜色</span>
          <div className="event-colors" role="group" aria-label="日程颜色">
            {eventColors.map((color) => (
              <button
                type="button"
                key={color.value}
                title={color.name}
                aria-label={color.name}
                aria-pressed={draft.color === color.value}
                style={{ backgroundColor: color.value }}
                onClick={() => set({ color: color.value })}
              >
                {draft.color === color.value && <Check size={16} />}
              </button>
            ))}
          </div>
        </div>
        <div className="event-field-row">
          <label className="event-field">
            重复
            <select
              value={draft.repeat.preset}
              onChange={(event) => repeat({ preset: event.target.value as RepeatPreset })}
            >
              {repeatChoices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          <label className="event-field">
            提前提醒
            <select
              value={draft.reminder ?? "none"}
              onChange={(event) =>
                set({ reminder: event.target.value === "none" ? null : Number(event.target.value) })
              }
            >
              {reminderChoices.map((choice) => (
                <option key={choice.value ?? "none"} value={choice.value ?? "none"}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {draft.repeat.preset === "weekly" && (
          <div className="event-weekdays" role="group" aria-label="重复星期">
            {["一", "二", "三", "四", "五", "六", "日"].map((label, index) => (
              <Button
                type="button"
                size="sm"
                variant={draft.repeat.weekdays.includes(index) ? "default" : "outline"}
                aria-label={`星期${label}`}
                aria-pressed={draft.repeat.weekdays.includes(index)}
                key={index}
                onClick={() =>
                  repeat({
                    weekdays: draft.repeat.weekdays.includes(index)
                      ? draft.repeat.weekdays.filter((day) => day !== index)
                      : [...draft.repeat.weekdays, index].sort(),
                  })
                }
              >
                {label}
              </Button>
            ))}
          </div>
        )}
        {draft.repeat.preset !== "none" && (
          <div className="event-field-row">
            <label className="event-field">
              结束重复
              <select
                value={draft.repeat.end}
                onChange={(event) =>
                  repeat({ end: event.target.value as EventDraft["repeat"]["end"] })
                }
              >
                <option value="never">永不</option>
                <option value="until">到某日</option>
                <option value="count">共 N 次</option>
              </select>
            </label>
            {draft.repeat.end === "until" && (
              <label className="event-field">
                截止日期（含当天）
                <input
                  required
                  type="date"
                  value={draft.repeat.until}
                  onChange={(event) => repeat({ until: event.target.value })}
                />
              </label>
            )}
            {draft.repeat.end === "count" && (
              <label className="event-field">
                总次数
                <input
                  required
                  type="number"
                  min="1"
                  step="1"
                  value={draft.repeat.count}
                  onChange={(event) => repeat({ count: event.target.value })}
                />
              </label>
            )}
          </div>
        )}
      </fieldset>
    </form>
  );
}
