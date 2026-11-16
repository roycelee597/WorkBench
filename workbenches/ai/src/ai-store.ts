import { create } from "zustand";
import {
  AiOrchestrator,
  type ConversationTurn,
  type OrchestratorEvent,
} from "../../../apps/desktop/src/core/ai/orchestrator";
import { MemoryRefTable } from "../../../apps/desktop/src/core/ai/ref-table";
import { aiRegistry, type AiRegistry } from "../../../apps/desktop/src/core/ai/registry";
import type { AiTarget, RegisteredAction } from "../../../apps/desktop/src/core/ai/action-types";
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
type ConversationApi = Pick<AiApi, "keyStatus" | "loadModel" | "chat"> &
  Partial<{
    openTarget: (target: AiTarget) => Promise<void>;
    openCreateForm: (actionName: string, draft: unknown) => Promise<void>;
  }>;
export interface AiProposal {
  actionName: string;
  draft: unknown;
  status: "pending" | "saving" | "saved" | "failed" | "cancelled" | "transferring" | "transferred";
  errors: string[];
  note?: string;
  result?: { message: string; target?: AiTarget };
  navigationError: string | null;
  openingTarget: boolean;
}
const editable = (proposal: AiProposal) => ["pending", "failed"].includes(proposal.status);
const localFailure = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;
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
  proposals: Record<string, AiProposal>;
  proposalBusy: boolean;
  getProposalAction: (id: string) => RegisteredAction | undefined;
  editProposal: (id: string, draft: unknown) => void;
  confirmProposal: (id: string) => Promise<void>;
  cancelProposal: (id: string) => void;
  transferProposal: (id: string) => Promise<void>;
  openProposalTarget: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  setDraft: (text: string) => void;
  send: () => Promise<void>;
  clear: () => void;
}

export function createAiStore(
  api: ConversationApi = aiApi,
  options: { now?: () => number; newId?: () => string; registry?: AiRegistry } = {},
) {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const refs = new MemoryRefTable({ now });
  const registry = options.registry ?? aiRegistry;
  const orchestrator = new AiOrchestrator({
    client: { chat: api.chat },
    registry,
    refs,
    now,
  });
  let refreshVersion = 0;
  return create<AiState>((set, get) => {
    function updateProposal(id: string, patch: Partial<AiProposal>) {
      set((state) => {
        const proposal = state.proposals[id];
        if (!proposal) return state;
        const proposals = { ...state.proposals, [id]: { ...proposal, ...patch } };
        return {
          proposals,
          proposalBusy: Object.values(proposals).some((item) =>
            ["saving", "transferring"].includes(item.status),
          ),
        };
      });
    }
    function append(event: OrchestratorEvent) {
      if (event.type === "status") {
        set({ activity: event.message });
        return;
      }
      const id = newId();
      set((state) => {
        const proposal: AiProposal | undefined =
          event.type === "prepared" && event.prepared.type === "proposal"
            ? {
                actionName: event.actionName,
                draft: event.prepared.draft,
                status: "pending",
                errors: [],
                ...(event.prepared.note ? { note: event.prepared.note } : {}),
                navigationError: null,
                openingTarget: false,
              }
            : undefined;
        return {
          messages: [...state.messages, { id, createdAt: now(), role: "assistant", event }],
          ...(proposal ? { proposals: { ...state.proposals, [id]: proposal } } : {}),
        };
      });
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
      proposals: {},
      proposalBusy: false,
      getProposalAction: (id) => {
        const proposal = get().proposals[id];
        return proposal ? registry.get(proposal.actionName) : undefined;
      },
      editProposal: (id, draft) => {
        const proposal = get().proposals[id];
        if (proposal && editable(proposal))
          updateProposal(id, { draft, errors: [], navigationError: null });
      },
      confirmProposal: async (id) => {
        const proposal = get().proposals[id];
        if (!proposal || !editable(proposal)) return;
        // 在任何异步步骤前锁住卡片，双击、重挂载和其他按钮都不能重复写入。
        updateProposal(id, { status: "saving", errors: [], navigationError: null });
        await Promise.resolve();
        try {
          const action = registry.get(proposal.actionName);
          if (action?.kind !== "write" || !action.validate || !action.execute)
            throw new Error("此操作当前不可用，请重新发起或手动新建。");
          const errors = action.validate(proposal.draft);
          if (errors.length) {
            updateProposal(id, { status: "pending", errors });
            return;
          }
          const result = await action.execute(proposal.draft);
          updateProposal(id, { status: "saved", result });
        } catch (error) {
          updateProposal(id, {
            status: "failed",
            errors: [localFailure(error, "保存未完成，请重试。")],
          });
        }
      },
      cancelProposal: (id) => {
        const proposal = get().proposals[id];
        if (proposal && editable(proposal))
          updateProposal(id, { status: "cancelled", errors: [], navigationError: null });
      },
      transferProposal: async (id) => {
        const proposal = get().proposals[id];
        if (!proposal || !editable(proposal)) return;
        updateProposal(id, { status: "transferring", navigationError: null });
        await Promise.resolve();
        try {
          if (!api.openCreateForm) throw new Error("暂时无法打开表单，请稍后重试。");
          // 转交当前编辑草稿，由手动表单继续处理；这里绝不调用 execute。
          await api.openCreateForm(proposal.actionName, proposal.draft);
          updateProposal(id, { status: "transferred", errors: [] });
        } catch (error) {
          updateProposal(id, {
            status: proposal.status,
            navigationError: localFailure(error, "未能打开表单，请重试。"),
          });
        }
      },
      openProposalTarget: async (id) => {
        const proposal = get().proposals[id];
        if (proposal?.status !== "saved" || !proposal.result?.target || proposal.openingTarget)
          return;
        updateProposal(id, { openingTarget: true, navigationError: null });
        try {
          if (!api.openTarget) throw new Error("暂时无法查看保存结果，请稍后重试。");
          await api.openTarget(proposal.result.target);
        } catch (error) {
          updateProposal(id, {
            navigationError: localFailure(error, "未能打开保存结果，请重试。"),
          });
        } finally {
          updateProposal(id, { openingTarget: false });
        }
      },
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
        if (get().pending || get().proposalBusy) return;
        refs.clear();
        set({ messages: [], history: [], proposals: {}, connectionError: null });
      },
    };
  });
}
export type AiStore = ReturnType<typeof createAiStore>;
export const useAiStore = createAiStore();
