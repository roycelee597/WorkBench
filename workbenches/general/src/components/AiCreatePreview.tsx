import { useId } from "react";
import type { PreviewProps } from "../../../../apps/desktop/src/core/ai/action-types";
import { aiCreateSummary, type AiCreateDraft } from "../ai-create-model";
import { EventFields } from "./EventFields";
import { ReminderFields } from "./ReminderFields";
import { TagInput } from "./TagInput";

/** 不含 form，可放在确认卡片或综合工作台的手动表单中。 */
export function AiCreateFields({
  draft,
  onChange,
  readOnly = false,
  autoFocus = false,
}: {
  draft: AiCreateDraft;
  onChange: (draft: AiCreateDraft) => void;
  readOnly?: boolean;
  autoFocus?: boolean;
}) {
  const id = useId();
  const change = (next: AiCreateDraft) => {
    if (!readOnly) onChange(next);
  };
  if (draft.type === "event")
    return (
      <EventFields
        draft={draft.form}
        onChange={(form) => change({ type: "event", form })}
        disabled={readOnly}
        autoFocus={autoFocus}
      />
    );
  if (draft.type === "reminder")
    return (
      <ReminderFields
        draft={draft.form}
        onChange={(form) => change({ type: "reminder", form })}
        disabled={readOnly}
        autoFocus={autoFocus}
      />
    );
  const update = (patch: Partial<typeof draft.form>) =>
    change({ type: "memo", form: { ...draft.form, ...patch } });
  return (
    <fieldset disabled={readOnly}>
      <label className="event-field" htmlFor={`${id}-title`}>
        标题
        <input
          id={`${id}-title`}
          autoFocus={autoFocus}
          value={draft.form.title}
          placeholder="备忘录标题"
          onChange={(event) => update({ title: event.target.value })}
        />
      </label>
      <label className="event-field" htmlFor={`${id}-content`}>
        正文
        <textarea
          id={`${id}-content`}
          rows={5}
          value={draft.form.content}
          placeholder="记录想留下的内容"
          onChange={(event) => update({ content: event.target.value })}
        />
      </label>
      <label className="event-all-day" htmlFor={`${id}-pinned`}>
        <input
          id={`${id}-pinned`}
          type="checkbox"
          checked={draft.form.pinned}
          onChange={(event) => update({ pinned: event.target.checked })}
        />
        置顶
      </label>
      <div className="event-field">
        <span>标签</span>
        <TagInput
          tags={draft.form.tags}
          suggestions={[]}
          disabled={readOnly}
          onChange={(tags) => update({ tags })}
        />
      </div>
    </fieldset>
  );
}

export function AiCreatePreview({
  draft,
  onChange,
  readOnly,
  errors,
}: PreviewProps<AiCreateDraft>) {
  return (
    <div className="event-form ai-create-preview">
      <p className="event-zone">{aiCreateSummary(draft)}</p>
      <AiCreateFields draft={draft} onChange={onChange} readOnly={readOnly} />
      {errors.length > 0 && (
        <ul className="event-form-error" role="alert">
          {errors.map((error, index) => (
            <li key={`${index}-${error}`}>{error}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
