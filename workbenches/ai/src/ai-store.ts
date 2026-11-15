import { create } from "zustand";
import {
  AiOrchestrator,
  type ConversationTurn,
  type OrchestratorEvent,
} from "../../../apps/desktop/src/core/ai/orchestrator";
import { MemoryRefTable } from "../../../apps/desktop/src/core/ai/ref-table";
import { aiRegistry } from "../../../apps/desktop/src/core/ai/registry";
import {
  aiError,
  AiClientError,
  DEFAULT_AI_MODEL,
  type AiKeyStatus,
  type AiModel,
} from "../../../apps/desktop/src/core/ai/llm-client";
import { aiApi, type AiApi } from "./api";

export type AiDisplayEvent = Exclude<OrchestratorEvent, { type: "status" }>;
export type AiMessage = { id: string; createdAt: number } & (
  { role: "user"; text: string } | { role: "assistant"; event: AiDisplayEvent }
);
type ConversationApi = Pick<AiApi, "keyStatus" | "loadModel" | "chat">;
interface AiState {
  draft: string;
  messages: AiMessage[];
  history: ConversationTurn[];
  key: AiKeyStatus | null;
  model: AiModel;
  checking: boolean;
  pending: boolean;
  activity: string;
  connectionError: Extract<OrchestratorEvent, { type: "error" }> | null;
  refresh: () => Promise<void>;
  setDraft: (text: string) => void;
  send: () => Promise<void>;
  clear: () => void;
}

export function createAiStore(
  api: ConversationApi = aiApi,
  options: { now?: () => number; newId?: () => string } = {},
) {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const refs = new MemoryRefTable({ now });
  const orchestrator = new AiOrchestrator({
    client: { chat: api.chat },
    registry: aiRegistry,
    refs,
    now,
  });
  let refreshVersion = 0;
  return create<AiState>((set, get) => {
    function append(event: OrchestratorEvent) {
      if (event.type === "status") {
        set({ activity: event.message });
        return;
      }
      set((state) => ({
        messages: [...state.messages, { id: newId(), createdAt: now(), role: "assistant", event }],
      }));
    }
    return {
      draft: "",
      messages: [],
      history: [],
      key: null,
      model: DEFAULT_AI_MODEL,
      checking: false,
      pending: false,
      activity: "",
      connectionError: null,
      setDraft: (draft) => set({ draft }),
      refresh: async () => {
        const version = ++refreshVersion;
        set({ checking: true, connectionError: null });
        try {
          const [key, model] = await Promise.all([api.keyStatus(), api.loadModel()]);
          if (version === refreshVersion) set({ key, model });
        } catch (failure) {
          const error = aiError(failure);
          if (version === refreshVersion)
            set({
              key: null,
              connectionError: {
                type: "error",
                code: error.code,
                message: error.message,
                fallback: "settings",
              },
            });
        } finally {
          if (version === refreshVersion) set({ checking: false });
        }
      },
      send: async () => {
        if (get().pending) return;
        const text = get().draft.trim();
        if (!text) return;
        if (Array.from(text).length > 1_000) {
          append({
            type: "error",
            message: "每次最多输入 1000 字，请缩短后再发送。",
            fallback: "manual",
          });
          return;
        }
        set((state) => ({
          pending: true,
          activity: "正在理解…",
          draft: "",
          connectionError: null,
          messages: [...state.messages, { id: newId(), createdAt: now(), role: "user", text }],
        }));
        try {
          const [key, model] = await Promise.all([api.keyStatus(), api.loadModel()]);
          set({ key, model });
          if (!key.configured) throw new AiClientError("KEY_MISSING");
          const result = await orchestrator.run({
            text,
            history: get().history,
            model,
            onEvent: append,
          });
          set((state) => ({ history: [...state.history, result.turn] }));
        } catch (failure) {
          const error = aiError(failure);
          append({
            type: "error",
            code: error.code,
            message: error.message,
            fallback:
              error.code === "KEY_MISSING" || error.code === "KEY_INVALID" ? "settings" : "manual",
          });
        } finally {
          set({ pending: false, activity: "" });
        }
      },
      clear: () => {
        if (get().pending) return;
        refs.clear();
        set({ messages: [], history: [], connectionError: null });
      },
    };
  });
}
export type AiStore = ReturnType<typeof createAiStore>;
export const useAiStore = createAiStore();
