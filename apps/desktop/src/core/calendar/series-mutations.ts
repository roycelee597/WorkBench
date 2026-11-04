import type { CalendarEvent, EventFields } from "../repositories/models";
import { validateEvent } from "../repositories/events";
import {
  floatingTime,
  occurrenceEnd,
  parseRule,
  serializeRule,
  seriesStarts,
  timestampFromFloating,
} from "./recurrence";

export type SeriesScope = "this" | "following" | "all";
export type SeriesPatch = Partial<
  Pick<
    EventFields,
    | "title"
    | "notes"
    | "start_at"
    | "end_at"
    | "all_day"
    | "timezone"
    | "rrule"
    | "color"
    | "remind_before_minutes"
  >
>;
export interface SeriesState {
  series: CalendarEvent;
  exceptions: readonly CalendarEvent[];
}
export interface MutationContext {
  now: number;
  deviceId: string;
  newId: string;
}
export interface EventChangeSet {
  created: CalendarEvent[];
  updated: CalendarEvent[];
}

const editable = [
  "title",
  "notes",
  "start_at",
  "end_at",
  "all_day",
  "timezone",
  "rrule",
  "color",
  "remind_before_minutes",
];
function clone(event: CalendarEvent): CalendarEvent {
  return { ...event, exdates: [...event.exdates] };
}
function touch(event: CalendarEvent, context: MutationContext): CalendarEvent {
  return { ...clone(event), updated_at: context.now, device_id: context.deviceId };
}
function tombstone(event: CalendarEvent, context: MutationContext): CalendarEvent {
  return { ...touch(event, context), deleted_at: context.now, deletion_group_id: context.newId };
}
function activeExceptions(state: SeriesState): CalendarEvent[] {
  return state.exceptions
    .filter(
      (event) =>
        event.recurrence_id === state.series.id &&
        event.deleted_at === null &&
        event.purged_at === null,
    )
    .map(clone);
}
function history(state: SeriesState, originalStart: number): number[] {
  if (!state.series.rrule || state.series.deleted_at !== null || state.series.purged_at !== null)
    throw new Error("原日程不是可用的重复日程");
  const starts = seriesStarts(state.series, state.series.start_at, originalStart + 1);
  if (starts.at(-1) !== originalStart) throw new Error("目标时间不是原日程的重复实例");
  return starts;
}
function unique(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}
function fresh(event: CalendarEvent, context: MutationContext): CalendarEvent {
  return {
    ...touch(event, context),
    id: context.newId,
    created_at: context.now,
    deleted_at: null,
    deletion_group_id: null,
    purged_at: null,
  };
}

export function editSeries(
  state: SeriesState,
  originalStart: number,
  scope: SeriesScope,
  patch: SeriesPatch,
  context: MutationContext,
): EventChangeSet {
  const previous = history(state, originalStart);
  for (const field of Object.keys(patch))
    if (!editable.includes(field)) throw new Error(`不允许修改字段 ${field}`);
  const series = clone(state.series);
  const exceptions = activeExceptions(state);
  if (scope === "this") {
    if (patch.rrule != null) throw new Error("仅此次不能创建重复规则");
    const existing = exceptions.find((event) => event.original_start_at === originalStart);
    if (
      !existing &&
      (context.newId === series.id || exceptions.some((event) => event.id === context.newId))
    )
      throw new Error("新日程 ID 必须唯一");
    const instance = existing ?? {
      ...fresh(series, context),
      start_at: originalStart,
      end_at: occurrenceEnd(series, originalStart),
      rrule: null,
      exdates: [],
      recurrence_id: series.id,
      original_start_at: originalStart,
    };
    const edited = {
      ...touch(instance, context),
      ...patch,
      rrule: null,
      end_at:
        patch.end_at ??
        occurrenceEnd(
          instance,
          patch.start_at ?? instance.start_at,
          patch.timezone ?? instance.timezone,
        ),
    };
    validateEvent(edited);
    const parent = {
      ...touch(series, context),
      exdates: unique([...series.exdates, originalStart]),
    };
    return existing
      ? { created: [], updated: [parent, edited] }
      : { created: [edited], updated: [parent] };
  }
  if (scope === "following" && previous.length === 1)
    return editSeries(state, originalStart, "all", patch, context);

  const newZone = patch.timezone ?? series.timezone;
  const selectedStart =
    patch.start_at ??
    (newZone === series.timezone
      ? originalStart
      : timestampFromFloating(floatingTime(originalStart, series.timezone), newZone));
  if (selectedStart === null) throw new Error("修改后的当地时间不存在");
  const wallShift =
    floatingTime(selectedStart, newZone) - floatingTime(originalStart, series.timezone);
  const mapStart = (start: number) =>
    timestampFromFloating(floatingTime(start, series.timezone) + wallShift, newZone);
  const baseStart = scope === "all" ? mapStart(series.start_at) : selectedStart;
  if (baseStart === null) throw new Error("修改后的起始时间不存在");
  const duration =
    patch.end_at !== undefined ? patch.end_at - selectedStart : series.end_at - series.start_at;
  const edited: CalendarEvent = {
    ...touch(series, context),
    ...patch,
    start_at: baseStart,
    end_at:
      patch.end_at === undefined ? occurrenceEnd(series, baseStart, newZone) : baseStart + duration,
    timezone: newZone,
  };

  if (scope === "all") {
    edited.exdates = unique(series.exdates.map((value) => mapStart(value) ?? value));
    validateEvent(edited);
    const movedExceptions =
      wallShift !== 0 || newZone !== series.timezone
        ? exceptions.map((event) => ({
            ...touch(event, context),
            original_start_at: mapStart(event.original_start_at!) ?? event.original_start_at,
          }))
        : [];
    return { created: [], updated: [edited, ...movedExceptions] };
  }

  if (context.newId === series.id || exceptions.some((event) => event.id === context.newId))
    throw new Error("新日程 ID 必须唯一");
  const options = parseRule(series.rrule!);
  const future = fresh(edited, context);
  if (patch.rrule === undefined && options.count != null)
    future.rrule = serializeRule({ ...options, count: options.count - previous.length + 1 });
  const compatible = (start: number) => seriesStarts(future, start, start + 1).includes(start);
  future.exdates = unique(
    series.exdates
      .filter((value) => value >= originalStart)
      .map(mapStart)
      .filter((value): value is number => value !== null)
      .filter(compatible),
  );
  validateEvent(future);
  const old = {
    ...touch(series, context),
    rrule: serializeRule({ ...options, count: null, until: new Date(originalStart - 1) }),
    exdates: series.exdates.filter((value) => value < originalStart),
  };
  const movedExceptions = exceptions
    .filter((event) => event.original_start_at! >= originalStart)
    .map((event) => {
      const mapped = mapStart(event.original_start_at!);
      return mapped !== null && compatible(mapped)
        ? { ...touch(event, context), recurrence_id: future.id, original_start_at: mapped }
        : tombstone(event, context);
    });
  return { created: [future], updated: [old, ...movedExceptions] };
}

export function deleteSeries(
  state: SeriesState,
  originalStart: number,
  scope: SeriesScope,
  context: MutationContext,
): EventChangeSet {
  const previous = history(state, originalStart);
  const series = clone(state.series);
  const exceptions = activeExceptions(state);
  if (scope === "all" || (scope === "following" && previous.length === 1))
    return {
      created: [],
      updated: [series, ...exceptions].map((event) => tombstone(event, context)),
    };
  if (scope === "this")
    return {
      created: [],
      updated: [
        { ...touch(series, context), exdates: unique([...series.exdates, originalStart]) },
        ...exceptions
          .filter((event) => event.original_start_at === originalStart)
          .map((event) => tombstone(event, context)),
      ],
    };
  const options = parseRule(series.rrule!);
  return {
    created: [],
    updated: [
      {
        ...touch(series, context),
        rrule: serializeRule({ ...options, count: null, until: new Date(originalStart - 1) }),
        exdates: series.exdates.filter((value) => value < originalStart),
      },
      ...exceptions
        .filter((event) => event.original_start_at! >= originalStart)
        .map((event) => tombstone(event, context)),
    ],
  };
}
