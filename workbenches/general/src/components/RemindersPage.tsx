import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell,
  CalendarDays,
  Check,
  Circle,
  Flag,
  Plus,
  Repeat2,
  Trash2,
  AlarmClock,
  ListTodo,
} from "lucide-react";
import { Button, Dialog, cn } from "@workbench/ui";
import { generalApi, type ReminderItem, type ReminderTarget } from "../api";
import {
  priorities,
  reminderFields,
  reminderForm,
  reminderGroups,
  filterReminders,
  reminderTime,
  type ReminderFormDraft,
  type ReminderGroup,
} from "../reminder-model";
import { repeatChoices } from "../calendar-model";
import { workspace } from "../workspace-store";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成，请刷新后重试。";
function ReminderEditor({
  item,
  onClose,
  onSaved,
}: {
  item?: ReminderItem | undefined;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [initial] = useState(() => reminderForm(item?.reminder));
  const [draft, setDraft] = useState<ReminderFormDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const historical = Boolean(item && (!item.isCurrent || item.completed_at !== null));
  const generated = item?.reminder.source === "event";
  const update = (patch: Partial<ReminderFormDraft>) => setDraft({ ...draft, ...patch });
  const repeat = (patch: Partial<ReminderFormDraft["repeat"]>) =>
    update({ repeat: { ...draft.repeat, ...patch } });
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      onClose();
      await onSaved();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  function target(): ReminderTarget {
    return {
      reminderId: item!.reminder.id,
      dueAt: item!.due_at,
      scheduleVersion: item!.reminder.schedule_version,
      ...(item?.occurrenceId ? { occurrenceId: item.occurrenceId } : {}),
    };
  }
  function save() {
    try {
      const fields = reminderFields(draft, initial, item?.reminder);
      if (generated && item) {
        fields.title = item.reminder.title;
        fields.notes = item.reminder.notes;
      }
      void run(() =>
        item
          ? generalApi.saveReminder(item.reminder.id, fields, item.reminder)
          : generalApi.createReminder(fields),
      );
    } catch (error) {
      setError(message(error));
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      className="calendar-form-dialog"
      title={deleting ? "删除这条提醒？" : item ? "提醒详情" : "新建提醒"}
      description={
        deleting
          ? "提醒及其实例状态会进入回收站，30 天内可以恢复。"
          : generated
            ? "此提醒由日程生成，请在日程中修改时间和内容。"
            : historical
              ? "这是已触发或完成的实例，下一次提醒独立保留。"
              : "为重要的事留一个提醒，也可以只作为待办。"
      }
      footer={
        deleting ? (
          <>
            <Button variant="outline" disabled={busy} onClick={() => setDeleting(false)}>
              返回
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void run(() => generalApi.deleteReminder(item!.reminder.id))}
            >
              移入回收站
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              关闭
            </Button>
            {item && item.completed_at === null && (
              <>
                <Button
                  variant="outline"
                  disabled={busy || item.due_at === null}
                  onClick={() => void run(() => generalApi.snoozeReminder(target()))}
                >
                  <AlarmClock />
                  稍后 10 分钟
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => void run(() => generalApi.completeReminder(target()))}
                >
                  <Check />
                  完成
                </Button>
              </>
            )}
            {!historical && (
              <Button form="reminder-form" type="submit" disabled={busy}>
                {busy ? "正在保存…" : "保存"}
              </Button>
            )}
          </>
        )
      }
    >
      {error && (
        <p className="event-form-error" role="alert">
          {error}
        </p>
      )}
      {!deleting &&
        (historical ? (
          <div className="reminder-history">
            <h3>{item!.title}</h3>
            <p>{reminderTime(item!, item!.reminder.timezone)}</p>
            <div>{item!.notes || "没有备注"}</div>
            {item!.completed_at !== null && (
              <p>完成于 {new Date(item!.completed_at).toLocaleString("zh-CN")}</p>
            )}
          </div>
        ) : (
          <form
            id="reminder-form"
            className="event-form"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <fieldset disabled={busy}>
              <label className="event-field">
                标题
                <input
                  required
                  autoFocus
                  value={draft.title}
                  readOnly={generated}
                  placeholder="需要记得做的事"
                  onChange={(event) => update({ title: event.target.value })}
                />
              </label>
              <label className="event-field">
                备注
                <textarea
                  rows={3}
                  value={draft.notes}
                  readOnly={generated}
                  onChange={(event) => update({ notes: event.target.value })}
                />
              </label>
              <label className="event-all-day">
                <input
                  type="checkbox"
                  checked={draft.timed}
                  disabled={generated}
                  onChange={(event) => update({ timed: event.target.checked })}
                />
                设置到期时间
              </label>
              {draft.timed && (
                <>
                  <label className="event-field">
                    到期时间
                    <input
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
                <label className="event-field">
                  优先级
                  <select
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
                <label className="event-field">
                  重复
                  <select
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
                  <label className="event-field">
                    结束重复
                    <select
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
                    <label className="event-field">
                      截止日期
                      <input
                        required
                        type="date"
                        value={draft.repeat.until}
                        readOnly={generated}
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
                        readOnly={generated}
                        onChange={(event) => repeat({ count: event.target.value })}
                      />
                    </label>
                  )}
                </div>
              )}
              {item && (
                <Button
                  type="button"
                  variant="ghost"
                  className="justify-self-start"
                  onClick={() => setDeleting(true)}
                >
                  <Trash2 />
                  删除提醒
                </Button>
              )}
            </fieldset>
          </form>
        ))}
    </Dialog>
  );
}

export function RemindersPage({
  focus,
  createRequested = false,
}: {
  focus?: ReminderTarget | null;
  createRequested?: boolean;
}) {
  const [items, setItems] = useState<ReminderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<ReminderGroup>(focus ? "all" : "today");
  const [selected, setSelected] = useState<string | null>(null);
  const [dismissedFocus, setDismissedFocus] = useState(false);
  const [newOpen, setNewOpen] = useState(createRequested);
  const [now, setNow] = useState(() => Date.now());
  const request = useRef(0);
  const reload = useCallback(async () => {
    const id = ++request.current;
    const rows = await generalApi.listReminders();
    if (id === request.current) setItems(rows);
  }, []);
  useEffect(() => {
    const generation = request;
    const id = ++generation.current;
    let current = true;
    let off: (() => void) | undefined;
    void generalApi
      .listReminders()
      .then((rows) => {
        if (current && id === generation.current) setItems(rows);
      })
      .catch((error: unknown) => {
        if (current) setError(message(error));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    void generalApi
      .subscribeChanges(() => {
        if (current) void reload().catch((error: unknown) => setError(message(error)));
      })
      .then((unsubscribe) => {
        if (current) off = unsubscribe;
        else unsubscribe();
      })
      .catch((error: unknown) => {
        if (current) setError(message(error));
      });
    const timer = setInterval(() => {
      setNow(Date.now());
      void reload().catch((error: unknown) => setError(message(error)));
    }, 30_000);
    if (createRequested) workspace.useWorkspace.setState({ reminderCreate: false });
    return () => {
      current = false;
      generation.current++;
      off?.();
      clearInterval(timer);
    };
  }, [reload, createRequested]);
  const rows = filterReminders(items, group, now);
  const active = selected
    ? items.find((item) => item.key === selected)
    : !dismissedFocus && focus
      ? items.find((item) =>
          focus.occurrenceId
            ? item.occurrenceId === focus.occurrenceId
            : item.reminder.id === focus.reminderId &&
              (focus.dueAt !== undefined
                ? item.due_at === focus.dueAt &&
                  item.reminder.schedule_version === focus.scheduleVersion
                : item.isCurrent),
        )
      : undefined;
  function close() {
    setSelected(null);
    setNewOpen(false);
    setDismissedFocus(true);
  }
  async function complete(item: ReminderItem) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await generalApi.completeReminder({
        reminderId: item.reminder.id,
        dueAt: item.due_at,
        scheduleVersion: item.reminder.schedule_version,
        ...(item.occurrenceId ? { occurrenceId: item.occurrenceId } : {}),
      });
      await reload();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="reminders-page">
      <aside className="reminder-groups">
        <div className="eyebrow">把小事交给提醒</div>
        <h2>提醒事项</h2>
        <nav aria-label="提醒分组">
          {reminderGroups.map((choice) => (
            <button
              type="button"
              key={choice.value}
              aria-pressed={group === choice.value}
              className={cn(group === choice.value && "selected")}
              onClick={() => setGroup(choice.value)}
            >
              {choice.value === "today" ? (
                <Bell size={16} />
              ) : choice.value === "completed" ? (
                <Check size={16} />
              ) : choice.value === "planned" ? (
                <CalendarDays size={16} />
              ) : (
                <ListTodo size={16} />
              )}
              <span>{choice.label}</span>
              <b>{filterReminders(items, choice.value, now).length}</b>
            </button>
          ))}
        </nav>
      </aside>
      <div className="reminders-main">
        <header className="reminders-heading">
          <div>
            <h2>{reminderGroups.find((choice) => choice.value === group)?.label}</h2>
            <p>
              {group === "today"
                ? "今天到期和已逾期的未完成提醒。"
                : group === "completed"
                  ? "已经完成的事，也值得记下来。"
                  : "每一件小事，都有自己的时间。"}
            </p>
          </div>
          <Button
            onClick={() => {
              setNewOpen(true);
              setError(null);
            }}
          >
            <Plus />
            新建提醒
          </Button>
        </header>
        {error && (
          <div className="calendar-error" role="alert">
            <span>{error}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void reload()
                  .then(() => setError(null))
                  .catch((error: unknown) => setError(message(error)))
              }
            >
              刷新
            </Button>
          </div>
        )}
        {!loading && focus && !active && !dismissedFocus && (
          <p className="reminder-focus-note">这条通知对应的提醒已改变或删除，请查看当前列表。</p>
        )}
        <div className="reminder-list" aria-busy={loading}>
          {rows.map((item) => {
            const due = item.snooze_until ?? item.due_at;
            return (
              <article
                className={cn("reminder-card", item.completed_at !== null && "completed")}
                key={item.key}
              >
                <button
                  type="button"
                  className="reminder-check"
                  disabled={busy || item.completed_at !== null}
                  aria-label={`完成 ${item.title}`}
                  aria-pressed={item.completed_at !== null}
                  onClick={() => void complete(item)}
                >
                  {item.completed_at !== null ? <Check size={18} /> : <Circle size={20} />}
                </button>
                <button
                  type="button"
                  className="reminder-content"
                  onClick={() => {
                    setSelected(item.key);
                    setNewOpen(false);
                  }}
                >
                  <span className="reminder-title">
                    {item.reminder.source === "event" && (
                      <CalendarDays size={15} aria-label="由日程生成" />
                    )}
                    {item.title}
                    {item.reminder.rrule && <Repeat2 size={13} aria-label="重复提醒" />}
                  </span>
                  {item.notes && (
                    <span className="reminder-note">{item.notes.split(/\r?\n/, 1)[0]}</span>
                  )}
                  <span
                    className={cn(
                      "reminder-due",
                      item.completed_at === null && due !== null && due < now && "overdue",
                    )}
                  >
                    {item.completed_at !== null
                      ? `完成于 ${new Date(item.completed_at).toLocaleString("zh-CN")}`
                      : reminderTime(item)}
                    {item.notified_at !== null && item.completed_at === null && (
                      <small>已通知</small>
                    )}
                    {!item.isCurrent && item.completed_at === null && <small>较早的实例</small>}
                  </span>
                </button>
                {item.priority > 0 && (
                  <span
                    className={`reminder-priority priority-${item.priority}`}
                    title={`${priorities[item.priority]}优先级`}
                  >
                    <Flag size={14} />
                    {priorities[item.priority]}
                  </span>
                )}
              </article>
            );
          })}
          {rows.length === 0 && (
            <div className="reminder-empty">
              <div className="empty-icon">
                <Bell size={28} strokeWidth={1.3} />
              </div>
              <h3>{loading ? "正在读取提醒…" : "这里暂时没有提醒"}</h3>
              <p>
                {group === "today"
                  ? "今天到期的提醒会显示在这里。"
                  : "新建一条提醒，把想做的事记下来。"}
              </p>
            </div>
          )}
        </div>
      </div>
      {(newOpen || active) && (
        <ReminderEditor
          key={newOpen ? "new" : active!.key}
          item={newOpen ? undefined : active}
          onClose={close}
          onSaved={async () => {
            await reload();
            setGroup("all");
          }}
        />
      )}
    </section>
  );
}
