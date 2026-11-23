import {
  MODULE_CHANNEL_PARAM,
  MODULE_ERROR_CODES,
  MODULE_PROTOCOL,
  type CalendarInput,
  type CalendarPatch,
  type EngineStartInput,
  type JsonValue,
  type MemoInput,
  type ModuleErrorCode,
  type ModuleRequest,
  type ModuleSubscription,
  type ModuleTheme,
  type ReminderInput,
  type ReminderPatch,
  type WorkbenchEventMap,
  type WorkbenchMethods,
} from "./protocol";

export * from "./protocol";

export class WorkbenchError extends Error {
  override readonly name = "WorkbenchError";

  constructor(
    readonly code: ModuleErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type Send = (message: ModuleRequest | ModuleSubscription, reply: MessagePort) => void;
type EventName = keyof WorkbenchEventMap;
type Listener = (value: unknown) => void;

export interface WorkbenchSdkOptions {
  timeoutMs?: number;
  channel?: string;
  send?: Send;
}

function browserSend(message: ModuleRequest | ModuleSubscription, reply: MessagePort) {
  if (typeof window === "undefined" || window.parent === window)
    throw new WorkbenchError("DISCONNECTED", "当前页面没有 WorkBench 宿主");
  window.parent.postMessage(message, "*", [reply]);
}

function requestId() {
  // 不透明 iframe 中 randomUUID 可能不可用，getRandomValues 不要求安全上下文。
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEventValue(name: EventName, value: unknown) {
  if (name === "theme-changed") return value === "light" || value === "dark";
  return (
    isRecord(value) &&
    (value.domain === "memos" || value.domain === "reminders" || value.domain === "calendar")
  );
}

class BridgeClient {
  private readonly waiting = new Map<string, () => void>();
  private readonly listeners = new Map<EventName, Set<Listener>>();
  private eventPort?: MessagePort;
  private closed = false;

  constructor(
    private readonly channel: string,
    private readonly send: Send,
    private readonly timeoutMs: number,
  ) {}

  request<Method extends keyof WorkbenchMethods>(
    method: Method,
    params: WorkbenchMethods[Method]["params"],
  ): Promise<WorkbenchMethods[Method]["result"]> {
    if (this.closed || !this.channel)
      return Promise.reject(new WorkbenchError("DISCONNECTED", "未连接到 WorkBench 宿主"));
    if (this.waiting.size >= 64)
      return Promise.reject(new WorkbenchError("RATE_LIMITED", "待处理请求过多，请稍后重试"));

    return new Promise((resolve, reject) => {
      const id = requestId();
      const { port1, port2 } = new MessageChannel();
      const finish = () => {
        clearTimeout(timer);
        this.waiting.delete(id);
        port1.close();
      };
      const fail = (code: ModuleErrorCode, message: string) => {
        finish();
        reject(new WorkbenchError(code, message));
      };
      const timer = setTimeout(() => fail("TIMEOUT", "等待 WorkBench 响应超时"), this.timeoutMs);
      this.waiting.set(id, () => fail("DISCONNECTED", "WorkBench 连接已关闭"));
      port1.onmessage = (event: MessageEvent<unknown>) => {
        const reply = event.data;
        if (
          !isRecord(reply) ||
          reply.protocol !== MODULE_PROTOCOL ||
          reply.kind !== "response" ||
          reply.id !== id ||
          typeof reply.ok !== "boolean"
        )
          return;
        if (reply.ok) {
          finish();
          resolve(reply.value as WorkbenchMethods[Method]["result"]);
        } else if (isRecord(reply.error) && typeof reply.error.message === "string") {
          const { code, message } = reply.error;
          const recognized = MODULE_ERROR_CODES.find((candidate) => candidate === code);
          fail(recognized ?? "INTERNAL_ERROR", message);
        } else {
          fail("INTERNAL_ERROR", "WorkBench 返回了无效的错误信息");
        }
      };
      port1.onmessageerror = () => fail("INTERNAL_ERROR", "无法读取 WorkBench 响应");
      try {
        this.send(
          { protocol: MODULE_PROTOCOL, kind: "request", channel: this.channel, id, method, params },
          port2,
        );
      } catch (error) {
        port2.close();
        if (error instanceof WorkbenchError) fail(error.code, error.message);
        else fail("INVALID_REQUEST", "无法发送请求，请检查参数能否序列化");
      }
    });
  }

  on<Name extends EventName>(event: Name, listener: (value: WorkbenchEventMap[Name]) => void) {
    if (this.closed || !this.channel)
      throw new WorkbenchError("DISCONNECTED", "未连接到 WorkBench 宿主");
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    const deliver: Listener = (value) => listener(value as WorkbenchEventMap[Name]);
    listeners.add(deliver);
    this.listeners.set(event, listeners);
    if (!this.eventPort) {
      const { port1, port2 } = new MessageChannel();
      this.eventPort = port1;
      port1.onmessage = (message: MessageEvent<unknown>) => {
        const packet = message.data;
        if (!isRecord(packet) || packet.protocol !== MODULE_PROTOCOL || packet.kind !== "event")
          return;
        const name = packet.event;
        if (
          (name === "theme-changed" || name === "data-changed") &&
          isEventValue(name, packet.value)
        ) {
          const handlers = this.listeners.get(name);
          if (handlers) for (const handler of [...handlers]) handler(packet.value);
        }
      };
      try {
        this.send({ protocol: MODULE_PROTOCOL, kind: "subscribe", channel: this.channel }, port2);
      } catch (error) {
        listeners.delete(deliver);
        port1.close();
        port2.close();
        delete this.eventPort;
        if (error instanceof WorkbenchError) throw error;
        throw new WorkbenchError("DISCONNECTED", "无法订阅 WorkBench 事件");
      }
    }
    return () => {
      listeners.delete(deliver);
      if (!listeners.size && this.listeners.get(event) === listeners) this.listeners.delete(event);
      if (!this.listeners.size) {
        this.eventPort?.close();
        delete this.eventPort;
      }
    };
  }

  dispose() {
    this.closed = true;
    this.eventPort?.close();
    this.listeners.clear();
    for (const close of this.waiting.values()) close();
  }
}

export function createWorkbenchSdk(options: WorkbenchSdkOptions = {}) {
  const channel =
    options.channel ??
    (typeof window === "undefined"
      ? ""
      : new URLSearchParams(window.location.hash.slice(1)).get(MODULE_CHANNEL_PARAM)) ??
    "";
  const client = new BridgeClient(
    channel,
    options.send ?? browserSend,
    options.timeoutMs ?? 30_000,
  );
  const request = client.request.bind(client);
  return {
    app: {
      getInfo: () => request("app.getInfo", {}),
      getLocale: () => request("app.getLocale", {}),
      getTheme: () => request("app.getTheme", {}),
      onThemeChange: (listen: (value: ModuleTheme) => void) => client.on("theme-changed", listen),
    },
    storage: {
      get: (key: string) => request("storage.get", { key }),
      set: (key: string, value: JsonValue) => request("storage.set", { key, value }),
      remove: (key: string) => request("storage.remove", { key }),
      list: (prefix?: string) => request("storage.list", prefix === undefined ? {} : { prefix }),
    },
    notifications: {
      send: (message: { title: string; body: string }) => request("notifications.send", message),
    },
    reminders: {
      list: (filter: { completed?: boolean } = {}) => request("reminders.list", filter),
      create: (input: ReminderInput) => request("reminders.create", input),
      update: (id: string, patch: ReminderPatch) => request("reminders.update", { id, patch }),
      complete: (id: string) => request("reminders.complete", { id }),
    },
    calendar: {
      listEvents: (range: { start: number; end: number }) => request("calendar.listEvents", range),
      createEvent: (input: CalendarInput) => request("calendar.createEvent", input),
      updateEvent: (id: string, patch: CalendarPatch) =>
        request("calendar.updateEvent", { id, patch }),
    },
    memos: {
      list: () => request("memos.list", {}),
      get: (id: string) => request("memos.get", { id }),
      create: (input: MemoInput) => request("memos.create", input),
      update: (id: string, patch: MemoInput) => request("memos.update", { id, patch }),
    },
    ui: {
      toast: (message: string) => request("ui.toast", { message }),
      confirm: (message: string) => request("ui.confirm", { message }),
      setTitle: (title: string) => request("ui.setTitle", { title }),
      setBadge: (count: number) => request("ui.setBadge", { count }),
    },
    events: {
      on: (event: "data-changed", listen: (value: WorkbenchEventMap["data-changed"]) => void) =>
        client.on(event, listen),
    },
    dialog: {
      open: () => request("dialog.open", {}),
    },
    engine: {
      start: (input: EngineStartInput) => request("engine.start", input),
      progress: (taskId: string) => request("engine.progress", { taskId }),
      cancel: (taskId: string) => request("engine.cancel", { taskId }),
      logs: (taskId: string) => request("engine.logs", { taskId }),
      probe: () => request("engine.probe", {}),
    },
    dispose: () => client.dispose(),
  };
}

export type WorkbenchSdk = ReturnType<typeof createWorkbenchSdk>;
