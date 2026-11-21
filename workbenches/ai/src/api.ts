import {
  aiError,
  AiClientError,
  aiKeyStatusSchema,
  aiModelSchema,
  aiCallLimitsSchema,
  DEFAULT_AI_MODEL,
  invokeAi,
  TauriLlmClient,
  type AiInvoker,
  type AiModel,
  type AiCallLimits,
  type LlmChatOptions,
  type LlmRequest,
} from "../../../apps/desktop/src/core/ai/llm-client";
import type { SettingsRepository } from "../../../apps/desktop/src/core/repositories/settings";
import type {
  AiCardPatch,
  AiMessageInput,
  AiMessagesRepository,
} from "../../../apps/desktop/src/core/repositories/ai-messages";
import {
  DEFAULT_AI_SHORTCUT,
  normalizeShortcut,
} from "../../../apps/desktop/src/core/shortcut-controller";
import { aiHostServices } from "./host-services";
import type { AiTarget } from "../../../apps/desktop/src/core/ai/action-types";
import { aiReadPolicy, publishReadPolicy } from "./ai-preferences";

export function createAiApi(
  getSettings: () => Promise<Pick<SettingsRepository, "getValue" | "setValue">>,
  call: AiInvoker = invokeAi,
  getMessages?: () => Promise<
    Pick<AiMessagesRepository, "listRecent" | "append" | "updateCard" | "clear">
  >,
) {
  const client = new TauriLlmClient(call);
  // 保存关闭失败时，本进程继续阻止读取，直到用户明确开启或成功重试。
  let privacyRevision = 0;
  async function readLimits(command: string, args?: Record<string, unknown>) {
    try {
      const parsed = aiCallLimitsSchema.safeParse(await call(command, args));
      if (!parsed.success) throw new AiClientError("BAD_RESPONSE");
      return parsed.data;
    } catch (error) {
      throw aiError(error);
    }
  }
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
    chat: (request: LlmRequest, options?: LlmChatOptions) => client.chat(request, options),
    loadHistory: async () => (await getMessages?.())?.listRecent() ?? [],
    appendHistory: async (input: AiMessageInput) => (await getMessages?.())?.append(input) ?? null,
    updateHistoryCard: async (id: string, patch: AiCardPatch) =>
      (await getMessages?.())?.updateCard(id, patch) ?? false,
    clearHistory: async () => (await getMessages?.())?.clear() ?? 0,
    async loadHistoryEnabled() {
      return (await (await getSettings()).getValue("ai.history_enabled")) !== false;
    },
    async saveHistoryEnabled(value: boolean) {
      await (await getSettings()).setValue("ai.history_enabled", value);
    },
    loadCallLimits: () => readLimits("ai_get_call_limits"),
    async saveCallLimits(limits: AiCallLimits) {
      if (!aiCallLimitsSchema.safeParse(limits).success) throw new AiClientError("BAD_RESPONSE");
      return readLimits("ai_set_call_limits", { limits });
    },
    async loadReadEnabled() {
      const revision = privacyRevision;
      const value = await (await getSettings()).getValue("ai.read_data_enabled");
      if (revision === privacyRevision && !privacyRevision) publishReadPolicy(value !== false);
      return aiReadPolicy.isAllowed() && (value !== false || revision !== 0);
    },
    async saveReadEnabled(value: boolean) {
      const revision = ++privacyRevision;
      if (!value) publishReadPolicy(false);
      await (await getSettings()).setValue("ai.read_data_enabled", value);
      if (revision === privacyRevision) publishReadPolicy(value);
    },
    async loadStepLimitEnabled() {
      return (await (await getSettings()).getValue("ai.step_limit_enabled")) !== false;
    },
    async saveStepLimitEnabled(value: boolean) {
      await (await getSettings()).setValue("ai.step_limit_enabled", value);
    },
    async openPrivacyPolicy() {
      try {
        await call("ai_open_platform", { privacy: true });
      } catch (error) {
        throw aiError(error);
      }
    },
    openTarget: (target: AiTarget) => aiHostServices.openTarget(target),
    openCreateForm: (actionName: string, draft: unknown) =>
      aiHostServices.openCreateForm(actionName, draft),
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
async function getData() {
  const { initializeDataLayer } =
    await import("../../../apps/desktop/src/core/repositories/initialize");
  return initializeDataLayer();
}
export const aiApi = createAiApi(
  async () => (await getData()).settings,
  invokeAi,
  async () => (await getData()).aiMessages,
);
