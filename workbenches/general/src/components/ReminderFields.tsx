import { useId, type ReactNode } from "react";
import { Button } from "@workbench/ui";
import { repeatChoices } from "../calendar-model";
import { priorities, type ReminderFormDraft } from "../reminder-model";

/** 与手动提醒编辑器共用；字段本身不创建表单。 */
export function ReminderFields({
  draft,
  onChange,
  disabled = false,
  generated = false,
  autoFocus = false,
  children,
}: {
  draft: ReminderFormDraft;
  onChange: (draft: ReminderFormDraft) => void;
  disabled?: boolean;
  generated?: boolean;
  autoFocus?: boolean;
  children?: ReactNode;
}) {
  const prefix = useId();
  const update = (patch: Partial<ReminderFormDraft>) => onChange({ ...draft, ...patch });
  const repeat = (patch: Partial<ReminderFormDraft["repeat"]>) =>
    update({ repeat: { ...draft.repeat, ...patch } });
  return (
    <fieldset disabled={disabled}>
      <label className="event-field" htmlFor={`${prefix}-field-1`}>
        标题
        <input
          id={`${prefix}-field-1`}
          required
          autoFocus={autoFocus}
          value={draft.title}
          readOnly={generated}
          placeholder="需要记得做的事"
          onChange={(event) => update({ title: event.target.value })}
        />
      </label>
      <label className="event-field" htmlFor={`${prefix}-field-2`}>
        备注
        <textarea
          id={`${prefix}-field-2`}
          rows={3}
          value={draft.notes}
          readOnly={generated}
          onChange={(event) => update({ notes: event.target.value })}
        />
      </label>
      <label className="event-all-day" htmlFor={`${prefix}-field-3`}>
        <input
          id={`${prefix}-field-3`}
          type="checkbox"
          checked={draft.timed}
          disabled={generated}
          onChange={(event) => update({ timed: event.target.checked })}
        />
        设置到期时间
      </label>
      {draft.timed && (
        <>
          <label className="event-field" htmlFor={`${prefix}-field-4`}>
            到期时间
            <input
              id={`${prefix}-field-4`}
              required
              type="datetime-local"
              value={draft.due}
              readOnly={generated}
              onChange={(event) => update({ due: event.target.value })}
            />
          </label>
          <p className="event-zone">提醒时区：{draft.zone}</p>
        </>
      )}
      <div className="event-field-row">
        <label className="event-field" htmlFor={`${prefix}-field-5`}>
          优先级
          <select
            id={`${prefix}-field-5`}
            value={draft.priority}
            onChange={(event) => update({ priority: Number(event.target.value) })}
          >
            {priorities.map((label, index) => (
              <option key={label} value={index}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="event-field" htmlFor={`${prefix}-field-6`}>
          重复
          <select
            id={`${prefix}-field-6`}
            disabled={!draft.timed || generated}
            value={draft.timed ? draft.repeat.preset : "none"}
            onChange={(event) =>
              repeat({
                preset: event.target.value as ReminderFormDraft["repeat"]["preset"],
              })
            }
          >
            {repeatChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {draft.timed && draft.repeat.preset === "weekly" && (
        <div className="event-weekdays" role="group" aria-label="提醒重复星期">
          {["一", "二", "三", "四", "五", "六", "日"].map((label, index) => (
            <Button
              type="button"
              key={label}
              disabled={generated}
              size="sm"
              variant={draft.repeat.weekdays.includes(index) ? "default" : "outline"}
              aria-pressed={draft.repeat.weekdays.includes(index)}
              aria-label={`星期${label}`}
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
      {draft.timed && draft.repeat.preset !== "none" && (
        <div className="event-field-row">
          <label className="event-field" htmlFor={`${prefix}-field-7`}>
            结束重复
            <select
              id={`${prefix}-field-7`}
              disabled={generated}
              value={draft.repeat.end}
              onChange={(event) =>
                repeat({ end: event.target.value as ReminderFormDraft["repeat"]["end"] })
              }
            >
              <option value="never">永不</option>
              <option value="until">到某日</option>
              <option value="count">共 N 次</option>
            </select>
          </label>
          {draft.repeat.end === "until" && (
            <label className="event-field" htmlFor={`${prefix}-field-8`}>
              截止日期
              <input
                id={`${prefix}-field-8`}
                required
                type="date"
                value={draft.repeat.until}
                readOnly={generated}
                onChange={(event) => repeat({ until: event.target.value })}
              />
            </label>
          )}
          {draft.repeat.end === "count" && (
            <label className="event-field" htmlFor={`${prefix}-field-9`}>
              总次数
              <input
                id={`${prefix}-field-9`}
                required
                type="number"
                min="1"
                step="1"
                value={draft.repeat.count}
                readOnly={generated}
                onChange={(event) => repeat({ count: event.target.value })}
              />
            </label>
          )}
        </div>
      )}

      {children}
    </fieldset>
  );
}
