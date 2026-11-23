import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import type { CalendarEvent, Memo, Reminder } from "../core/repositories/models";
import { completeReminder } from "../core/scheduler/reminder-service";
import { expandEvents } from "../core/calendar/recurrence";
import { BridgeError, method, type ModulePermission } from "./bridge";
import { moduleApi, moduleDataLayer, sequenceModuleWrite } from "./module-api";

const empty = z.strictObject({}).default({});
const id = z.string().uuid();
const title = z.string().trim().min(1).max(200);
const body = z.string().max(20_000);
const key = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/\p{Cc}/u.test(value));
const timestamp = z.number().int().min(-8.64e15).max(8.64e15);
const memoInput = z.strictObject({
  title: z.string().max(200).optional(),
  content: body.optional(),
  pinned: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
});
const reminderInput = z.strictObject({
  title,
  notes: body.optional(),
  due_at: timestamp.nullable().optional(),
  priority: z.number().int().min(0).max(3).optional(),
});
const eventInput = z.strictObject({
  title,
  notes: body.optional(),
  start_at: timestamp,
  end_at: timestamp,
  all_day: z.boolean().optional(),
});
const engineTask = z.strictObject({ taskId: id });
const engineStart = z.strictObject({
  input: z.json(),
  paths: z.array(id).max(16).optional(),
  execPaths: z.array(id).max(16).optional(),
});
const engineError = z.object({
  code: z.string().regex(/^[A-Z_]{1,40}$/u),
  message: z.string().max(512),
});

function memoView({ id, title, content, pinned, tags }: Memo) {
  return { id, title, content, pinned, tags };
}
function reminderView({ id, title, notes, due_at, completed_at, priority }: Reminder) {
  return { id, title, notes, due_at, completed_at, priority };
}
function eventView({ id, title, notes, start_at, end_at, all_day }: CalendarEvent) {
  return { id, title, notes, start_at, end_at, all_day };
}
function own<Record extends { source_workbench: string | null }>(
  record: Record | null,
  moduleId: string,
): Record {
  if (record?.source_workbench !== moduleId)
    throw new BridgeError("PERMISSION_DENIED", "只能修改本模块创建的记录");
  return record;
}

// zod 的可选字段允许显式 undefined，仓库只接收缺省字段或实际值。
function omitUndefined<T extends object>(
  value: T,
): { [Field in keyof T]: Exclude<T[Field], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [Field in keyof T]: Exclude<T[Field], undefined>;
  };
}

export interface ModuleSurface {
  active(): boolean;
  permissions(): readonly string[];
  theme(): "light" | "dark";
  notify(title: string, body?: string): void;
  confirm(message: string): Promise<boolean>;
  setTitle(title: string): void;
  setBadge(count: number): void;
}

export function moduleMethods(moduleId: string, ui: ModuleSurface) {
  const write = <Result>(permission: ModulePermission, run: () => Promise<Result>) =>
    sequenceModuleWrite(moduleId, () => {
      if (!ui.active()) throw new BridgeError("DISCONNECTED", "模块页面已关闭");
      if (!ui.permissions().includes(permission))
        throw new BridgeError("PERMISSION_DENIED", "该模块未获此权限，或权限已撤销");
      return run();
    });
  const engine = async (operation: string, params: unknown = {}) => {
    try {
      return await invoke("module_engine_call", { id: moduleId, method: operation, params });
    } catch (error) {
      const diagnostic = engineError.safeParse(error);
      if (diagnostic.success) throw new BridgeError(diagnostic.data.code, diagnostic.data.message);
      throw error;
    }
  };
  const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
  const db = moduleDataLayer;
  return {
    "app.getInfo": method(empty, "read", async () => ({
      name: "WorkBench",
      version: await getVersion(),
    })),
    "app.getTheme": method(empty, "read", () => ui.theme()),
    "app.getLocale": method(empty, "read", () => "zh-CN"),
    "storage.get": method(
      z.strictObject({ key }),
      "read",
      async ({ key }) => {
        const data = await moduleApi.readStorage(moduleId);
        return Object.hasOwn(data, key) ? data[key] : null;
      },
      "storage",
    ),
    "storage.list": method(
      z.strictObject({ prefix: z.string().max(160).optional() }),
      "read",
      async ({ prefix }) =>
        Object.entries(await moduleApi.readStorage(moduleId))
          .filter(([key]) => key.startsWith(prefix ?? ""))
          .map(([key, value]) => ({ key, value })),
      "storage",
    ),
    "storage.set": method(
      z.strictObject({ key, value: z.json() }),
      "write",
      ({ key, value }) =>
        write("storage", () => moduleApi.writeStorage(moduleId, key, false, value)),
      "storage",
    ),
    "storage.remove": method(
      z.strictObject({ key }),
      "write",
      ({ key }) => write("storage", () => moduleApi.writeStorage(moduleId, key, true)),
      "storage",
    ),
    "notifications.send": method(
      z.strictObject({ title, body: z.string().max(500) }),
      "notice",
      ({ title, body }) => ui.notify(title, body),
      "notifications",
    ),
    "memos.list": method(
      empty,
      "read",
      async () => (await (await db()).memos.list()).map(memoView),
      "memos:read",
    ),
    "memos.get": method(
      z.strictObject({ id }),
      "read",
      async ({ id }) => {
        const memo = await (await db()).memos.get(id);
        return memo ? memoView(memo) : null;
      },
      "memos:read",
    ),
    "memos.create": method(
      memoInput,
      "write",
      (input) =>
        write("memos:write", async () =>
          memoView(await (await db()).memos.createForModule(moduleId, omitUndefined(input))),
        ),
      "memos:write",
    ),
    "memos.update": method(
      z.strictObject({ id, patch: memoInput }),
      "write",
      ({ id, patch }) =>
        write("memos:write", async () => {
          const memo = await (await db()).memos.updateForModule(moduleId, id, omitUndefined(patch));
          if (!memo) throw new BridgeError("PERMISSION_DENIED", "只能修改本模块创建的记录");
          return memoView(memo);
        }),
      "memos:write",
    ),
    "reminders.list": method(
      z.strictObject({ completed: z.boolean().optional() }),
      "read",
      async ({ completed }) =>
        (await (await db()).reminders.list())
          .filter((row) => completed === undefined || (row.completed_at !== null) === completed)
          .map(reminderView),
      "reminders:read",
    ),
    "reminders.create": method(
      reminderInput,
      "write",
      (input) =>
        write("reminders:write", async () =>
          reminderView(
            await (
              await db()
            ).reminders.create({
              ...omitUndefined(input),
              timezone: zone(),
              source_workbench: moduleId,
            }),
          ),
        ),
      "reminders:write",
    ),
    "reminders.update": method(
      z.strictObject({ id, patch: reminderInput.partial() }),
      "write",
      ({ id, patch }) =>
        write("reminders:write", async () => {
          const { reminders } = await db();
          const row = own(await reminders.get(id), moduleId);
          return reminderView(await reminders.update(id, omitUndefined(patch), row));
        }),
      "reminders:write",
    ),
    "reminders.complete": method(
      z.strictObject({ id }),
      "write",
      ({ id }) =>
        write("reminders:write", async () => {
          const data = await db();
          const row = own(await data.reminders.get(id), moduleId);
          await completeReminder(
            data,
            { reminderId: id, scheduleVersion: row.schedule_version },
            Date.now(),
          );
        }),
      "reminders:write",
    ),
    "calendar.listEvents": method(
      z
        .strictObject({ start: timestamp, end: timestamp })
        .refine(({ start, end }) => end > start && end - start <= 366 * 86_400_000),
      "read",
      async (range) =>
        expandEvents(await (await db()).events.list(), range).map(({ event, start_at, end_at }) =>
          eventView({ ...event, start_at, end_at }),
        ),
      "calendar:read",
    ),
    "calendar.createEvent": method(
      eventInput.refine(({ start_at, end_at }) => end_at > start_at),
      "write",
      (input) =>
        write("calendar:write", async () =>
          eventView(
            await (
              await db()
            ).events.create({
              ...omitUndefined(input),
              timezone: zone(),
              source_workbench: moduleId,
            }),
          ),
        ),
      "calendar:write",
    ),
    "calendar.updateEvent": method(
      z.strictObject({ id, patch: eventInput.partial() }),
      "write",
      ({ id, patch }) =>
        write("calendar:write", async () => {
          const { events } = await db();
          const row = own(await events.get(id), moduleId);
          return eventView(
            await events.update(id, omitUndefined(patch), { updatedAt: row.updated_at }),
          );
        }),
      "calendar:write",
    ),
    "ui.toast": method(
      z.strictObject({ message: z.string().trim().min(1).max(500) }),
      "notice",
      ({ message }) => ui.notify(message),
    ),
    "ui.confirm": method(
      z.strictObject({ message: z.string().trim().min(1).max(500) }),
      "interaction",
      ({ message }) => ui.confirm(message),
    ),
    "ui.setTitle": method(z.strictObject({ title }), "write", ({ title }) => ui.setTitle(title)),
    "ui.setBadge": method(
      z.strictObject({ count: z.number().int().min(0).max(999) }),
      "write",
      ({ count }) => ui.setBadge(count),
    ),
    "dialog.open": method(
      empty,
      "interaction",
      () => invoke("module_dialog_open", { id: moduleId }),
      "dialog.open",
    ),
    "engine.start": method(
      engineStart,
      "interaction",
      (params) => {
        if (params.execPaths?.length && !ui.permissions().includes("engine.exec_paths"))
          throw new BridgeError("PERMISSION_DENIED", "该模块未获执行路径权限");
        return write("engine", () => engine("start", params));
      },
      "engine",
    ),
    "engine.progress": method(
      engineTask,
      "engine",
      (params) => engine("progress", params),
      "engine",
    ),
    "engine.cancel": method(
      engineTask,
      "write",
      (params) => write("engine", () => engine("cancel", params)),
      "engine",
    ),
    "engine.logs": method(engineTask, "engine", (params) => engine("logs", params), "engine"),
    "engine.probe": method(empty, "engine", () => engine("probe"), "engine"),
  };
}
