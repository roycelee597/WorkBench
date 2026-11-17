import type { EventDraft } from "../calendar-model";
import { EventFields } from "./EventFields";

export function EventForm({
  draft,
  onChange,
  onSubmit,
  busy,
  formId = "event-form",
  autoFocus = true,
}: {
  draft: EventDraft;
  onChange: (draft: EventDraft) => void;
  onSubmit: () => void;
  busy: boolean;
  formId?: string;
  autoFocus?: boolean;
}) {
  return (
    <form
      id={formId}
      className="event-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSubmit();
      }}
    >
      <EventFields draft={draft} onChange={onChange} disabled={busy} autoFocus={autoFocus} />
    </form>
  );
}
