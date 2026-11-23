import { z } from "zod";
import { MODULE_PROTOCOL, type ModuleEvent, type ModuleResponse } from "@workbench/sdk";
import type { ModuleManifest } from "@workbench/manifest";

export type ModulePermission = ModuleManifest["permissions"][number];
export type ModuleRate = "read" | "write" | "notice" | "interaction" | "engine";
type ModuleDomain = "memos" | "calendar" | "reminders";

export interface ModuleMethod {
  permission?: ModulePermission;
  rate: ModuleRate;
  execute: (params: unknown) => Promise<unknown>;
}

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function method<Params>(
  schema: z.ZodType<Params>,
  rate: ModuleRate,
  effect: (params: Params) => unknown,
  permission?: ModulePermission,
): ModuleMethod {
  return {
    ...(permission === undefined ? {} : { permission }),
    rate,
    async execute(params) {
      const input = schema.safeParse(params);
      if (!input.success) throw new BridgeError("INVALID_REQUEST", "请求参数无效");
      return effect(input.data);
    },
  };
}

const envelope = {
  protocol: z.literal(MODULE_PROTOCOL),
  channel: z.string().uuid(),
};
const incoming = z.discriminatedUnion("kind", [
  z.strictObject({
    ...envelope,
    kind: z.literal("request"),
    id: z.string().regex(/^[\w-]{1,80}$/),
    method: z.string().max(80),
    params: z.unknown(),
  }),
  z.strictObject({ ...envelope, kind: z.literal("subscribe") }),
]);

const limits: Record<ModuleRate, { capacity: number; span: number }> = {
  read: { capacity: 120, span: 10_000 },
  write: { capacity: 24, span: 10_000 },
  notice: { capacity: 3, span: 30_000 },
  interaction: { capacity: 3, span: 15_000 },
  engine: { capacity: 60, span: 10_000 },
};
type PermissionSource = () => readonly string[];

export class ModuleRateLimiter {
  private readonly timestamps = new Map<ModuleRate, number[]>();
  constructor(private readonly now: () => number = () => performance.now()) {}
  consume(rate: ModuleRate) {
    const { capacity, span } = limits[rate];
    const now = this.now();
    const recent = (this.timestamps.get(rate) ?? []).filter((timestamp) => now - timestamp < span);
    if (recent.length >= capacity)
      throw new BridgeError("RATE_LIMITED", "操作过于频繁，请稍后重试");
    recent.push(now);
    this.timestamps.set(rate, recent);
  }
}

export class ModuleBridge {
  private subscriber: MessagePort | undefined;
  private readonly pending = new Set<string>();
  private closed = false;

  constructor(
    private readonly options: {
      source: () => Window | null;
      channel: string;
      permissions: PermissionSource;
      methods: Readonly<Record<string, ModuleMethod>>;
      limiter: ModuleRateLimiter;
    },
  ) {}

  private allowed(permission: ModulePermission) {
    return this.options.permissions().includes(permission);
  }

  async receive(event: Pick<MessageEvent<unknown>, "source" | "origin" | "data" | "ports">) {
    const source = this.options.source();
    if (this.closed || !source || event.source !== source || event.origin !== "null") return;
    if (event.ports.length !== 1) return;
    const port = event.ports[0]!;
    const packet = incoming.safeParse(event.data);
    if (!packet.success || packet.data.channel !== this.options.channel) {
      port.close();
      return;
    }
    if (packet.data.kind === "subscribe") {
      this.subscriber?.close();
      this.subscriber = port;
      return;
    }

    const { id, method: name, params } = packet.data;
    const reply = (response: ModuleResponse) => {
      if (!this.closed) port.postMessage(response);
    };
    let accepted = false;
    try {
      const route = Object.hasOwn(this.options.methods, name) ? this.options.methods[name] : null;
      if (!route) throw new BridgeError("INVALID_REQUEST", "未知模块方法");
      if (route.permission && !this.allowed(route.permission))
        throw new BridgeError("PERMISSION_DENIED", "该模块未获此权限，或权限已撤销");
      if (this.pending.has(id)) throw new BridgeError("CONFLICT", "请求 ID 已在使用");
      if (this.pending.size >= 8) throw new BridgeError("RATE_LIMITED", "请求数量过多，请稍后重试");
      this.options.limiter.consume(route.rate);
      const bytes = name === "storage.set" ? 10 * 1024 * 1024 + 2048 : 128 * 1024;
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(params);
      } catch {
        throw new BridgeError("INVALID_REQUEST", "请求参数必须是可序列化的 JSON");
      }
      if (serialized !== undefined && new TextEncoder().encode(serialized).length > bytes)
        throw new BridgeError("INVALID_REQUEST", "请求参数过大");
      this.pending.add(id);
      accepted = true;
      const value = await route.execute(params);
      if (route.permission && !this.allowed(route.permission))
        throw new BridgeError("PERMISSION_DENIED", "操作期间权限已撤销");
      reply({ protocol: MODULE_PROTOCOL, kind: "response", id, ok: true, value: value ?? null });
    } catch (error) {
      reply({
        protocol: MODULE_PROTOCOL,
        kind: "response",
        id,
        ok: false,
        error:
          error instanceof BridgeError
            ? { code: error.code, message: error.message }
            : { code: "INTERNAL_ERROR", message: "模块请求失败" },
      });
    } finally {
      if (accepted) this.pending.delete(id);
      port.close();
    }
  }

  publish(event: ModuleEvent["event"], value: unknown) {
    if (!this.closed)
      this.subscriber?.postMessage({ protocol: MODULE_PROTOCOL, kind: "event", event, value });
  }

  dataChanged(domain: ModuleDomain) {
    if (this.allowed(`${domain}:read`)) this.publish("data-changed", { domain });
  }

  close() {
    this.closed = true;
    this.subscriber?.close();
    this.subscriber = undefined;
  }
}
