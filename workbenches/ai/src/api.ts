import {
  aiError,
  AiClientError,
  aiKeyStatusSchema,
  aiModelSchema,
  DEFAULT_AI_MODEL,
  invokeAi,
  TauriLlmClient,
  type AiInvoker,
  type AiModel,
  type LlmRequest,
} from "../../../apps/desktop/src/core/ai/llm-client";
import type { SettingsRepository } from "../../../apps/desktop/src/core/repositories/settings";
import {
  DEFAULT_AI_SHORTCUT,
  normalizeShortcut,
} from "../../../apps/desktop/src/core/shortcut-controller";
import { aiHostServices } from "./host-services";

export function createAiApi(
  getSettings: () => Promise<Pick<SettingsRepository, "getValue" | "setValue">>,
  call: AiInvoker = invokeAi,
) {
  const client = new TauriLlmClient(call);
  async function status(command = "ai_key_status", args?: Record<string, unknown>) {
    try {
      const result = aiKeyStatusSchema.safeParse(await call(command, args));
      if (!result.success) throw new AiClientError("BAD_RESPONSE");
      return result.data;
    } catch (error) {
      throw aiError(error);
    }
  }
  return {
    chat: (request: LlmRequest) => client.chat(request),
    async getStoredShortcut(): Promise<string> {
      const value = await (await getSettings()).getValue("ai.global_shortcut");
      return value === undefined
        ? DEFAULT_AI_SHORTCUT
        : normalizeShortcut(typeof value === "string" ? value : "");
    },
    async setStoredShortcut(value: string) {
      await (await getSettings()).setValue("ai.global_shortcut", normalizeShortcut(value));
    },
    getGlobalShortcut: () => aiHostServices.getShortcut(),
    setGlobalShortcut: (value: string) => aiHostServices.setShortcut(value),
    keyStatus: () => status(),
    saveKey: (key: string) => status("ai_key_set", { key }),
    async clearKey() {
      try {
        await call("ai_key_clear");
      } catch (error) {
        throw aiError(error);
      }
    },
    async testKey() {
      try {
        const result = await call("ai_key_test");
        if (
          typeof result !== "object" ||
          result === null ||
          !("ok" in result) ||
          result.ok !== true
        )
          throw new AiClientError("BAD_RESPONSE");
      } catch (error) {
        throw aiError(error);
      }
    },
    async loadModel(): Promise<AiModel> {
      const stored = await (await getSettings()).getValue("ai.model");
      const model = aiModelSchema.safeParse(stored);
      return model.success ? model.data : DEFAULT_AI_MODEL;
    },
    async saveModel(model: AiModel) {
      const parsed = aiModelSchema.safeParse(model);
      if (!parsed.success) throw new AiClientError("BAD_RESPONSE");
      await (await getSettings()).setValue("ai.model", parsed.data);
    },
    // 固定官方链接经现有 Rust 系统浏览器入口打开，前端 CSP 不放开联网。
    async openPlatform() {
      try {
        await call("ai_open_platform");
      } catch (error) {
        throw aiError(error);
      }
    },
  };
}
export type AiApi = ReturnType<typeof createAiApi>;
export const aiApi = createAiApi(async () => {
  const { initializeDataLayer } =
    await import("../../../apps/desktop/src/core/repositories/initialize");
  return (await initializeDataLayer()).settings;
});
