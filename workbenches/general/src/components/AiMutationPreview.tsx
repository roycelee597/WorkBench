import { useId } from "react";
import { Button } from "@workbench/ui";
import type { PreviewProps } from "../../../../apps/desktop/src/core/ai/action-types";
import {
  aiDeleteDestination,
  aiMutationDiff,
  selectedMutationItems,
  type AiMutationDraft,
} from "../ai-mutation-model";
import {
  reminderChoices,
  repeatChoices,
  toggleAllDay,
  type EventDraft,
  type RepeatDraft,
} from "../calendar-model";
import { priorities, type ReminderFormDraft } from "../reminder-model";

function RepeatEditor({
  value,
  onChange,
}: {
  value: RepeatDraft;
  onChange: (value: RepeatDraft) => void;
}) {
  const id = useId();
  const change = (patch: Partial<RepeatDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="event-form">
      <label className="event-field" htmlFor={`${id}-repeat`}>
        新的重复规则
        <select
          id={`${id}-repeat`}
          value={value.preset}
          onChange={(event) => change({ preset: event.target.value as RepeatDraft["preset"] })}
        >
          {repeatChoices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      {value.preset === "weekly" && (
        <div role="group" aria-label="新的重复星期" className="event-weekdays">
          {["一", "二", "三", "四", "五", "六", "日"].map((day, index) => (
            <Button
              key={day}
              type="button"
              size="sm"
              variant={value.weekdays.includes(index) ? "default" : "outline"}
              aria-label={`星期${day}`}
              aria-pressed={value.weekdays.includes(index)}
              onClick={() =>
                change({
                  weekdays: value.weekdays.includes(index)
                    ? value.weekdays.filter((value) => value !== index)
                    : [...value.weekdays, index].sort(),
                })
              }
            >
              {day}
            </Button>
          ))}
        </div>
      )}
      {value.preset !== "none" && (
        <>
          <label className="event-field" htmlFor={`${id}-end`}>
            结束重复
            <select
              id={`${id}-end`}
              value={value.end}
              onChange={(event) => change({ end: event.target.value as RepeatDraft["end"] })}
            >
              <option value="never">永不</option>
              <option value="until">到某日</option>
              <option value="count">共 N 次</option>
            </select>
          </label>
          {value.end === "until" && (
            <label className="event-field" htmlFor={`${id}-until`}>
              截止日期（含当天）
              <input
                id={`${id}-until`}
                type="date"
                value={value.until}
                onChange={(event) => change({ until: event.target.value })}
              />
            </label>
          )}
          {value.end === "count" && (
            <label className="event-field" htmlFor={`${id}-count`}>
              总次数
              <input
                id={`${id}-count`}
                type="number"
                min="1"
                max="999"
                step="1"
                value={value.count}
                onChange={(event) => change({ count: event.target.value })}
              />
            </label>
          )}
        </>
      )}
    </div>
  );
}

/** 只列实际有变化的字段；删除去向直接反映已有系列删除语义。 */
export function AiMutationPreview({
  draft,
  onChange,
  readOnly,
  errors,
  scope,
}: PreviewProps<AiMutationDraft>) {
  const id = useId();
  const updateEvent = (patch: Partial<EventDraft>) => {
    if (!readOnly && draft.next?.type === "event")
      onChange({ ...draft, next: { type: "event", form: { ...draft.next.form, ...patch } } });
  };
  const updateReminder = (patch: Partial<ReminderFormDraft>) => {
    if (!readOnly && draft.next?.type === "reminder")
      onChange({ ...draft, next: { type: "reminder", form: { ...draft.next.form, ...patch } } });
  };
  const isDelete = draft.kind.endsWith("delete");
  const itemType = draft.kind.startsWith("event") ? "日程" : "提醒";
  return (
    <div className="event-form ai-mutation-preview">
      <h3>
        {isDelete ? "删除" : "修改"}
        {itemType}：{draft.items[0]?.title}
      </h3>
      <ul>
        {selectedMutationItems(draft).map((item) => (
          <li key={item.id}>
            {item.when} · {item.title}
          </li>
        ))}
      </ul>
      {scope === "this" && aiMutationDiff(draft).some((row) => row.field === "repeat") && (
        <p>仅这次不会改变整个系列的重复规则。</p>
      )}
      {isDelete ? (
        aiDeleteDestination(draft, scope).map((note) => <p key={note}>{note}</p>)
      ) : (
        <fieldset disabled={readOnly}>
          {aiMutationDiff(draft).map((row) => {
            const inputId = `${id}-${row.field}`;
            const next = draft.next;
            let editor;
            if (next?.type === "event") {
              const form = next.form;
              if (row.field === "title" || row.field === "notes")
                editor =
                  row.field === "title" ? (
                    <input
                      id={inputId}
                      value={form.title}
                      onChange={(event) => updateEvent({ title: event.target.value })}
                    />
                  ) : (
                    <textarea
                      id={inputId}
                      value={form.notes}
                      onChange={(event) => updateEvent({ notes: event.target.value })}
                    />
                  );
              if (row.field === "start" || row.field === "end")
                editor = (
                  <input
                    id={inputId}
                    type={form.allDay ? "date" : "datetime-local"}
                    value={form[row.field]}
                    onChange={(event) => updateEvent({ [row.field]: event.target.value })}
                  />
                );
              if (row.field === "allDay")
                editor = (
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={form.allDay}
                    onChange={(event) => updateEvent(toggleAllDay(form, event.target.checked))}
                  />
                );
              if (row.field === "reminder")
                editor = (
                  <select
                    id={inputId}
                    value={form.reminder ?? "none"}
                    onChange={(event) =>
                      updateEvent({
                        reminder: event.target.value === "none" ? null : Number(event.target.value),
                      })
                    }
                  >
                    {reminderChoices.map((choice) => (
                      <option key={choice.value ?? "none"} value={choice.value ?? "none"}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                );
              if (row.field === "repeat")
                editor = (
                  <RepeatEditor
                    value={form.repeat}
                    onChange={(repeat) => updateEvent({ repeat })}
                  />
                );
            }
            if (next?.type === "reminder") {
              const form = next.form;
              if (row.field === "title" || row.field === "notes")
                editor =
                  row.field === "title" ? (
                    <input
                      id={inputId}
                      value={form.title}
                      onChange={(event) => updateReminder({ title: event.target.value })}
                    />
                  ) : (
                    <textarea
                      id={inputId}
                      value={form.notes}
                      onChange={(event) => updateReminder({ notes: event.target.value })}
                    />
                  );
              if (row.field === "priority")
                editor = (
                  <select
                    id={inputId}
                    value={form.priority}
                    onChange={(event) => updateReminder({ priority: Number(event.target.value) })}
                  >
                    {priorities.map((label, value) => (
                      <option key={label} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                );
              if (row.field === "repeat")
                editor = (
                  <RepeatEditor
                    value={form.repeat}
                    onChange={(repeat) => updateReminder({ repeat })}
                  />
                );
              if (row.field === "due")
                editor = (
                  <div>
                    <label htmlFor={`${inputId}-enabled`}>
                      <input
                        id={`${inputId}-enabled`}
                        type="checkbox"
                        checked={form.timed}
                        onChange={(event) => updateReminder({ timed: event.target.checked })}
                      />
                      设置到期时间
                    </label>
                    {form.timed && (
                      <input
                        id={inputId}
                        type="datetime-local"
                        value={form.due}
                        onChange={(event) => updateReminder({ due: event.target.value })}
                      />
                    )}
                  </div>
                );
            }
            return (
              <div className="event-field" key={row.field}>
                {row.field === "repeat" ? (
                  <span>{row.label}</span>
                ) : (
                  <label htmlFor={inputId}>{row.label}</label>
                )}
                <p className="text-sm text-muted-foreground">
                  {row.before} → {row.after}
                </p>
                {editor}
              </div>
            );
          })}
        </fieldset>
      )}
      {errors.length > 0 && (
        <ul className="event-form-error" role="alert">
          {errors.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
