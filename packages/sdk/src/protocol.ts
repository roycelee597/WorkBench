export const MODULE_PROTOCOL = "workbench-module-v1";
export const MODULE_CHANNEL_PARAM = "wb-channel";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ModuleTheme = "light" | "dark";
export interface WorkbenchEventMap {
  "theme-changed": ModuleTheme;
  "data-changed": { domain: "memos" | "reminders" | "calendar" };
}

export const MODULE_ERROR_CODES = [
  "INVALID_REQUEST",
  "PERMISSION_DENIED",
  "RATE_LIMITED",
  "NOT_FOUND",
  "CONFLICT",
  "QUOTA_EXCEEDED",
  "INTERNAL_ERROR",
  "UNAVAILABLE",
  "TIMEOUT",
  "DISCONNECTED",
] as const;
export type ModuleErrorCode = (typeof MODULE_ERROR_CODES)[number];
export interface ModuleError {
  code: ModuleErrorCode;
  message: string;
}

export interface ModuleRequest {
  protocol: typeof MODULE_PROTOCOL;
  kind: "request";
  channel: string;
  id: string;
  method: string;
  params: unknown;
}

export interface ModuleSubscription {
  protocol: typeof MODULE_PROTOCOL;
  kind: "subscribe";
  channel: string;
}

export type ModuleResponse = {
  protocol: typeof MODULE_PROTOCOL;
  kind: "response";
  id: string;
} & ({ ok: true; value: unknown } | { ok: false; error: ModuleError });

export type ModuleEvent = {
  [Name in keyof WorkbenchEventMap]: {
    protocol: typeof MODULE_PROTOCOL;
    kind: "event";
    event: Name;
    value: WorkbenchEventMap[Name];
  };
}[keyof WorkbenchEventMap];

export interface ModuleMemo {
  id: string;
  title: string;
  content: string;
  pinned: boolean;
  tags: string[];
}
export interface ModuleReminder {
  id: string;
  title: string;
  notes: string;
  due_at: number | null;
  completed_at: number | null;
  priority: number;
}
export interface ModuleCalendarEvent {
  id: string;
  title: string;
  notes: string;
  start_at: number;
  end_at: number;
  all_day: boolean;
}

export type MemoInput = Partial<Omit<ModuleMemo, "id">>;
export type ReminderPatch = Partial<Omit<ModuleReminder, "id" | "completed_at">>;
export type ReminderInput = Required<Pick<ReminderPatch, "title">> & ReminderPatch;
export type CalendarPatch = Partial<Omit<ModuleCalendarEvent, "id">>;
export type CalendarInput = Required<Pick<CalendarPatch, "title" | "start_at" | "end_at">> &
  CalendarPatch;

export interface EngineStartInput {
  input: JsonValue;
  paths?: string[];
  execPaths?: string[];
}

export interface EngineTask {
  taskId: string;
}
export interface EngineProgress {
  status: "running" | "succeeded" | "failed" | "cancelled";
  progress?: { done: number | null; total: number | null };
  result?: JsonValue;
  error?: string;
}
export interface EngineProbe {
  available: boolean;
  error?: string;
}
export interface ModulePathHandle {
  handle: string;
  name: string;
}

type Rpc<Params, Result> = { params: Params; result: Result };
type Empty = Record<string, never>;

export interface WorkbenchMethods {
  "app.getInfo": Rpc<Empty, { name: string; version: string }>;
  "app.getTheme": Rpc<Empty, ModuleTheme>;
  "app.getLocale": Rpc<Empty, string>;
  "storage.get": Rpc<{ key: string }, JsonValue>;
  "storage.set": Rpc<{ key: string; value: JsonValue }, null>;
  "storage.remove": Rpc<{ key: string }, null>;
  "storage.list": Rpc<{ prefix?: string }, { key: string; value: JsonValue }[]>;
  "notifications.send": Rpc<{ title: string; body: string }, null>;
  "reminders.list": Rpc<{ completed?: boolean }, ModuleReminder[]>;
  "reminders.create": Rpc<ReminderInput, ModuleReminder>;
  "reminders.update": Rpc<{ id: string; patch: ReminderPatch }, ModuleReminder>;
  "reminders.complete": Rpc<{ id: string }, null>;
  "calendar.listEvents": Rpc<{ start: number; end: number }, ModuleCalendarEvent[]>;
  "calendar.createEvent": Rpc<CalendarInput, ModuleCalendarEvent>;
  "calendar.updateEvent": Rpc<{ id: string; patch: CalendarPatch }, ModuleCalendarEvent>;
  "memos.list": Rpc<Empty, ModuleMemo[]>;
  "memos.get": Rpc<{ id: string }, ModuleMemo | null>;
  "memos.create": Rpc<MemoInput, ModuleMemo>;
  "memos.update": Rpc<{ id: string; patch: MemoInput }, ModuleMemo>;
  "ui.toast": Rpc<{ message: string }, null>;
  "ui.confirm": Rpc<{ message: string }, boolean>;
  "ui.setTitle": Rpc<{ title: string }, null>;
  "ui.setBadge": Rpc<{ count: number }, null>;
  "dialog.open": Rpc<Empty, ModulePathHandle | null>;
  "engine.start": Rpc<EngineStartInput, EngineTask>;
  "engine.progress": Rpc<EngineTask, EngineProgress>;
  "engine.cancel": Rpc<EngineTask, null>;
  "engine.logs": Rpc<EngineTask, string[]>;
  "engine.probe": Rpc<Empty, EngineProbe>;
}
