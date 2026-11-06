import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { generalApi, workspace } from "@workbench/general";
import {
  quickEnvelopeSchema,
  quickReplySchema,
  quickRequestSchema,
} from "../core/quick-create-contract";

let host: Promise<void> | undefined;
let offHost: (() => void) | undefined;
export function initializeQuickHost() {
  host ??= (async () => {
    let sequence = Promise.resolve();
    const drain = async () => {
      const messages = await invoke<unknown[]>("take_quick_requests");
      for (const raw of messages) {
        sequence = sequence
          .then(async () => {
            const envelope = quickEnvelopeSchema.safeParse(raw);
            if (!envelope.success) {
              console.error("快速新建信封无效", envelope.error);
              if (raw && typeof raw === "object" && "id" in raw && typeof raw.id === "string")
                await invoke("finish_quick_request", {
                  id: raw.id,
                  result: { ok: false, error: "快速新建请求无效" },
                });
              return;
            }
            const { id, payload } = envelope.data;
            let result: { ok: true; data: unknown } | { ok: false; error: string };
            try {
              const parsed = quickRequestSchema.safeParse(payload);
              if (!parsed.success)
                throw new Error(parsed.error.issues[0]?.message ?? "快速新建参数无效");
              if (parsed.data.type === "preferences")
                result = { ok: true, data: await generalApi.quickPreferences() };
              else {
                const saved = await generalApi.quickCreate(parsed.data.input);
                if (saved.type === "memo") workspace.acceptCreatedMemo(saved.record);
                result = { ok: true, data: { type: saved.type, id: saved.record.id } };
                if (workspace.useWorkspace.getState().autostartOffer)
                  await invoke("show_main").catch(console.error);
              }
            } catch (error) {
              result = {
                ok: false,
                error: (error instanceof Error ? error.message : "保存失败，请重试").slice(0, 500),
              };
            }
            await invoke("finish_quick_request", { id, result });
          })
          .catch((error: unknown) => console.error("快速新建响应失败", error));
      }
      await sequence;
    };
    offHost = await listen("quick-requests", () => {
      void drain().catch(console.error);
    });
    await drain();
  })().catch((error: unknown) => {
    host = undefined;
    offHost?.();
    throw error;
  });
  return host;
}
let client: Promise<void> | undefined;
let offClient: (() => void) | undefined;
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
async function initializeClient() {
  client ??= listen<unknown>("quick-result", (event) => {
    const parsed = quickReplySchema.safeParse(event.payload);
    if (!parsed.success) return;
    const request = pending.get(parsed.data.id);
    if (!request) return;
    pending.delete(parsed.data.id);
    if (parsed.data.result.ok) request.resolve(parsed.data.result.data);
    else request.reject(new Error(parsed.data.result.error));
  })
    .then((off) => {
      offClient = off;
    })
    .catch((error: unknown) => {
      client = undefined;
      throw error;
    });
  return client;
}
export async function sendQuickRequest(payload: unknown): Promise<unknown> {
  quickRequestSchema.parse(payload);
  await initializeClient();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    void invoke("quick_request", { id, payload }).catch((error: unknown) => {
      pending.delete(id);
      reject(new Error(error instanceof Error ? error.message : String(error)));
    });
  });
}
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    offHost?.();
    offClient?.();
    for (const request of pending.values()) request.reject(new Error("开发热更新中，请重新保存"));
    pending.clear();
  });
