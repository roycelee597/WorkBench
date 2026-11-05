import { useCallback, useEffect, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import zhCnLocale from "@fullcalendar/core/locales/zh-cn";
import type { DatesSetArg, EventInput, EventDropArg } from "@fullcalendar/core";
import type { EventResizeDoneArg } from "@fullcalendar/interaction";
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Repeat2 } from "lucide-react";
import { Button, Dialog, cn } from "@workbench/ui";
import {
  generalApi,
  type CalendarEvent,
  type EventOccurrence,
  type SeriesPatch,
  type SeriesScope,
  type TimeRange,
} from "../api";
import {
  dateInZone,
  draftFields,
  draftPatch,
  newEventDraft,
  occurrenceDraft,
  parseLocal,
  scopedPatch,
  shiftDay,
  type EventDraft,
} from "../calendar-model";
import { EventForm } from "./EventForm";

type View = "dayGridMonth" | "timeGridWeek" | "timeGridDay";
interface Editor {
  initial: EventDraft;
  draft: EventDraft;
  occurrence?: EventOccurrence;
  series?: CalendarEvent;
}
interface Pending {
  occurrence: EventOccurrence;
  series: CalendarEvent;
  operation: "edit" | "delete";
  patch?: SeriesPatch;
}
const scopes = [
  {
    value: "this",
    label: "仅此次",
    description: "只调整当前这一次日程。",
    deleteDescription: "只删除当前这一次及对应的例外。",
  },
  {
    value: "following",
    label: "此后全部",
    description: "从这一次开始，调整后续日程。",
    deleteDescription: "删除本次和后续实例，保留此前的日程。",
  },
  {
    value: "all",
    label: "全部",
    description: "调整整个系列，保留已有例外。",
    deleteDescription: "整个系列、已有例外和关联提醒一起进入回收站。",
  },
] as const;
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : error === "内容已发生变化，请刷新后重试"
      ? "内容已发生变化，请取消后重新打开日程。"
      : "操作失败，请重试。";

export function CalendarPage() {
  const calendar = useRef<FullCalendar>(null);
  const [range, setRange] = useState<TimeRange | null>(null);
  const [view, setView] = useState<View>("timeGridWeek");
  const [title, setTitle] = useState("");
  const [data, setData] = useState<{
    events: CalendarEvent[];
    occurrences: EventOccurrence[];
    defaultReminder: number | null;
  }>({ events: [], occurrences: [], defaultReminder: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [scope, setScope] = useState<SeriesScope>("this");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const request = useRef(0);
  const writing = useRef(false);
  const reload = useCallback(async (current: TimeRange) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const result = await generalApi.loadCalendar(current);
      if (id === request.current) setData(result);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!range) return;
    let current = true;
    const id = ++request.current;
    void generalApi
      .loadCalendar(range)
      .then((result) => {
        if (current && id === request.current) setData(result);
      })
      .catch((error: unknown) => {
        if (current && id === request.current) setError(errorMessage(error));
      })
      .finally(() => {
        if (current && id === request.current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [range]);
  async function run(write: () => Promise<unknown>) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setError(null);
    try {
      await write();
      setEditor(null);
      setPending(null);
      setConfirmDelete(false);
      if (range) await reload(range);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  function closeEditor() {
    if (busy) return;
    setEditor(null);
    setPending(null);
    setConfirmDelete(false);
    setError(null);
    if (error && range) void reload(range).catch((error: unknown) => setError(errorMessage(error)));
  }
  function openNew(start: number, end: number, allDay = false) {
    if (busy || loading) return;
    const draft = newEventDraft(start, end, allDay, data.defaultReminder);
    setError(null);
    setEditor({ draft, initial: draft });
  }
  function openOccurrence(occurrence: EventOccurrence) {
    const series = data.events.find((event) => event.id === occurrence.series_id);
    if (!series) return;
    const draft = occurrenceDraft(occurrence, series);
    setError(null);
    setEditor({ draft, initial: draft, occurrence, series });
  }
  function chooseScope(change: Pending) {
    setPending(change);
    setScope("this");
  }
  function save() {
    if (!editor) return;
    try {
      if (!editor.occurrence) {
        const input = draftFields(editor.draft);
        void run(() => generalApi.createEvent(input));
        return;
      }
      const patch = draftPatch(editor.draft, editor.initial);
      if (editor.series?.rrule)
        chooseScope({
          occurrence: editor.occurrence,
          series: editor.series!,
          operation: "edit",
          patch,
        });
      else void run(() => generalApi.updateEvent(editor.occurrence!.event.id, patch));
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  function remove() {
    if (!editor?.occurrence) return;
    if (editor.series?.rrule)
      chooseScope({ occurrence: editor.occurrence, series: editor.series!, operation: "delete" });
    else setConfirmDelete(true);
  }
  function applyScope() {
    if (!pending) return;
    const { occurrence, series, operation } = pending;
    void run(() =>
      operation === "delete"
        ? generalApi.deleteEventOccurrence(series.id, occurrence.original_start_at, scope)
        : generalApi.editEventOccurrence(
            series.id,
            occurrence.original_start_at,
            scope,
            scopedPatch(pending.patch ?? {}, occurrence, series, scope),
          ),
    );
  }
  function move(info: EventDropArg | EventResizeDoneArg) {
    const occurrence = data.occurrences.find((event) => event.key === info.event.id);
    const series = occurrence && data.events.find((event) => event.id === occurrence.series_id);
    if (!occurrence || !series || !info.event.start) {
      info.revert();
      return;
    }
    try {
      const start = info.event.allDay
        ? parseLocal(info.event.startStr, occurrence.event.timezone)
        : info.event.start.getTime();
      const end = info.event.allDay
        ? parseLocal(
            info.event.endStr || shiftDay(info.event.startStr, 1),
            occurrence.event.timezone,
          )
        : (info.event.end?.getTime() ?? start + 3_600_000);
      const patch: SeriesPatch = { end_at: end };
      if (start !== occurrence.start_at) patch.start_at = start;
      if (info.event.allDay !== occurrence.event.all_day) patch.all_day = info.event.allDay;
      // 先还原拖动预览；选择范围并保存成功后，以数据库中的展开结果重新渲染。
      info.revert();
      if (series.rrule) chooseScope({ occurrence, series, operation: "edit", patch });
      else void run(() => generalApi.updateEvent(occurrence.event.id, patch));
    } catch (error) {
      info.revert();
      setError(errorMessage(error));
    }
  }
  const events: EventInput[] = data.occurrences.map((occurrence) => ({
    id: occurrence.key,
    title: occurrence.event.title,
    start: occurrence.event.all_day
      ? dateInZone(occurrence.start_at, occurrence.event.timezone)
      : new Date(occurrence.start_at),
    end: occurrence.event.all_day
      ? dateInZone(occurrence.end_at, occurrence.event.timezone)
      : new Date(occurrence.end_at),
    allDay: occurrence.event.all_day,
    backgroundColor: occurrence.event.color ?? "#547c69",
    borderColor: occurrence.event.color ?? "#547c69",
    classNames: occurrence.is_exception ? ["calendar-exception"] : [],
    extendedProps: {
      repeating: Boolean(data.events.find((event) => event.id === occurrence.series_id)?.rrule),
    },
  }));
  const modal = Boolean(editor || pending);
  return (
    <section className="calendar-page">
      <div className="calendar-toolbar">
        <div className="calendar-heading">
          <span className="eyebrow">给重要的事留出时间</span>
          <h2>{title || "日程安排"}</h2>
        </div>
        <div className="calendar-actions">
          <div className="calendar-navigation">
            <Button
              size="icon"
              variant="outline"
              aria-label="上一个时间段"
              disabled={busy}
              onClick={() => calendar.current?.getApi().prev()}
            >
              <ChevronLeft />
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => calendar.current?.getApi().today()}
            >
              今天
            </Button>
            <Button
              size="icon"
              variant="outline"
              aria-label="下一个时间段"
              disabled={busy}
              onClick={() => calendar.current?.getApi().next()}
            >
              <ChevronRight />
            </Button>
          </div>
          <div className="calendar-views" role="group" aria-label="日历视图">
            {(
              [
                { value: "dayGridMonth", label: "月" },
                { value: "timeGridWeek", label: "周" },
                { value: "timeGridDay", label: "日" },
              ] as const
            ).map((item) => (
              <button
                type="button"
                key={item.value}
                aria-pressed={view === item.value}
                className={cn(view === item.value && "selected")}
                disabled={busy}
                onClick={() => calendar.current?.getApi().changeView(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <Button
            disabled={busy || loading}
            onClick={() => {
              const start = new Date();
              start.setMinutes(0, 0, 0);
              openNew(start.getTime(), start.getTime() + 3_600_000);
            }}
          >
            <Plus />
            新建日程
          </Button>
        </div>
      </div>
      {error && (
        <div className="calendar-error" role="alert">
          <span>{error}</span>
          {!modal && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setError(null);
                if (range)
                  void reload(range).catch((error: unknown) => setError(errorMessage(error)));
              }}
            >
              刷新日程
            </Button>
          )}
        </div>
      )}
      <p className="calendar-hint">
        <CalendarDays size={14} />
        点击空白格新建，拖动日程调整时间，拖动边缘调整时长。
        {loading && <span role="status">正在读取…</span>}
      </p>
      <div className="calendar-surface" aria-label="日程日历" aria-busy={loading || busy}>
        <FullCalendar
          ref={calendar}
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          locale={zhCnLocale}
          initialView="timeGridWeek"
          firstDay={1}
          timeZone="local"
          headerToolbar={false}
          height="100%"
          nowIndicator
          allDayText="全天"
          slotMinTime="00:00:00"
          scrollTime="08:00:00"
          slotDuration="00:30:00"
          snapDuration="00:15:00"
          eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
          slotLabelFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
          editable={!busy && !loading && !modal}
          eventResizableFromStart
          eventDurationEditable={!busy && !loading && !modal}
          eventStartEditable={!busy && !loading && !modal}
          dayMaxEvents={3}
          eventDisplay="block"
          events={events}
          datesSet={(arg: DatesSetArg) => {
            setTitle(arg.view.title);
            setView(arg.view.type as View);
            if (range?.start !== arg.start.getTime() || range.end !== arg.end.getTime()) {
              setLoading(true);
              setRange({ start: arg.start.getTime(), end: arg.end.getTime() });
            }
          }}
          dateClick={(info) => {
            if (info.allDay) {
              const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
              openNew(
                parseLocal(info.dateStr, zone),
                parseLocal(shiftDay(info.dateStr, 1), zone),
                true,
              );
            } else openNew(info.date.getTime(), info.date.getTime() + 3_600_000);
          }}
          eventClick={(info) => {
            if (!busy && !loading) {
              const occurrence = data.occurrences.find((event) => event.key === info.event.id);
              if (occurrence) openOccurrence(occurrence);
            }
          }}
          eventDrop={move}
          eventResize={move}
          eventContent={(info) => (
            <div className="calendar-event-content">
              {info.timeText && <span>{info.timeText}</span>}
              <b>
                {Boolean(info.event.extendedProps.repeating) && <Repeat2 size={11} />}
                {info.event.title}
              </b>
            </div>
          )}
        />
      </div>
      <Dialog
        open={modal}
        className={pending ? "calendar-scope-dialog" : "calendar-form-dialog"}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        title={
          pending
            ? pending.operation === "delete"
              ? "删除重复日程"
              : "修改重复日程"
            : editor?.occurrence
              ? "编辑日程"
              : "新建日程"
        }
        description={
          pending
            ? "请选择本次操作的作用范围。关联提醒将一并同步。"
            : "安排一段专注的时间，保存后可继续调整。"
        }
        footer={
          pending ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => setPending(null)}>
                返回
              </Button>
              <Button
                variant={pending.operation === "delete" ? "destructive" : "default"}
                disabled={busy}
                onClick={applyScope}
              >
                {busy ? "正在保存…" : pending.operation === "delete" ? "移入回收站" : "确认修改"}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  closeEditor();
                }}
              >
                取消
              </Button>
              {editor?.occurrence && (
                <Button variant="ghost" disabled={busy} onClick={remove}>
                  删除
                </Button>
              )}
              <Button type="submit" form="event-form" disabled={busy}>
                {busy ? "正在保存…" : "保存日程"}
              </Button>
            </>
          )
        }
      >
        {error && (
          <p role="alert" className="event-form-error">
            {error}
          </p>
        )}
        {pending ? (
          <div className="calendar-scopes" role="radiogroup" aria-label="重复日程作用范围">
            {scopes.map((choice) => (
              <label key={choice.value} className={cn(scope === choice.value && "selected")}>
                <input
                  type="radio"
                  autoFocus={choice.value === "this"}
                  name="scope"
                  value={choice.value}
                  checked={scope === choice.value}
                  disabled={busy}
                  onChange={() => setScope(choice.value)}
                />
                <span>
                  <b>{choice.label}</b>
                  <small>
                    {pending.operation === "delete" ? choice.deleteDescription : choice.description}
                  </small>
                </span>
              </label>
            ))}
            {pending.patch?.rrule !== undefined && <p>选择「仅此次」时，不改变系列的重复规则。</p>}
          </div>
        ) : (
          editor && (
            <EventForm
              draft={editor.draft}
              onChange={(draft) => setEditor({ ...editor, draft })}
              onSubmit={save}
              busy={busy}
            />
          )
        )}
      </Dialog>
      <Dialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!busy) setConfirmDelete(open);
        }}
        title="删除这条日程？"
        description="日程和关联提醒会一起移入回收站，30 天内可以恢复。"
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmDelete(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (editor?.occurrence)
                  void run(() => generalApi.deleteEvent(editor.occurrence!.event.id));
              }}
            >
              移入回收站
            </Button>
          </>
        }
      />
    </section>
  );
}
