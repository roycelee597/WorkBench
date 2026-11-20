import { create } from "zustand";
import {
  AiOrchestrator,
  type ConversationTurn,
  type OrchestratorEvent,
} from "../../../apps/desktop/src/core/ai/orchestrator";
import { MemoryRefTable } from "../../../apps/desktop/src/core/ai/ref-table";
import { aiRegistry, type AiRegistry } from "../../../apps/desktop/src/core/ai/registry";
import type {
  AiTarget,
  Prepared,
  RegisteredAction,
  ResultItem,
  SeriesScope,
} from "../../../apps/desktop/src/core/ai/action-types";
import {
  aiError,
  AiClientError,
  DEFAULT_AI_MODEL,
  type AiKeyStatus,
  type AiModel,
} from "../../../apps/desktop/src/core/ai/llm-client";
import type { AiMessageRecord } from "../../../apps/desktop/src/core/repositories/ai-messages";
import { aiApi, type AiApi } from "./api";
import { aiReadPolicy } from "./ai-preferences";
import { historyCard, historyInput } from "./ai-history";

export type AiDisplayEvent =
  Exclude<OrchestratorEvent, { type: "status" }> | { type: "archived"; record: AiMessageRecord };
export type AiMessage = { id: string; createdAt: number } & (
  { role: "user"; text: string } | { role: "assistant"; event: AiDisplayEvent }
);
type ConversationApi = Pick<AiApi, "keyStatus" | "loadModel" | "chat"> &
  Partial<Pick<AiApi, "loadHistory" | "appendHistory" | "updateHistoryCard" | "clearHistory">> &
  Partial<{
    openTarget: (target: AiTarget) => Promise<void>;
    openCreateForm: (actionName: string, draft: unknown) => Promise<void>;
    loadReadEnabled: () => Promise<boolean>;
    loadStepLimitEnabled: () => Promise<boolean>;
  }>;
export interface AiReadPolicy {
  isAllowed: () => boolean;
  subscribe: (listener: (allowed: boolean) => void) => () => void;
}
export interface AiProposal {
  actionName: string;
  draft: unknown;
  status:
    | "pending"
    | "saving"
    | "saved"
    | "failed"
    | "cancelled"
    | "transferring"
    | "transferred"
    | "expired";
  errors: string[];
  note?: string;
  result?: { message: string; target?: AiTarget };
  navigationError: string | null;
  openingTarget: boolean;
  needsScope: boolean;
  scope?: SeriesScope;
  selections?: Array<{ id: string; title: string; when: string }>;
  selectedIds: string[];
  readGeneration: number;
}
export interface AiChoice {
  actionName: string;
  prepared: Extract<Prepared<unknown>, { type: "choose" }>;
  status: "pending" | "choosing" | "chosen" | "expired";
  errors: string[];
  target?: AiTarget;
}
const editable = (proposal: AiProposal) => ["pending", "failed"].includes(proposal.status);
const localFailure = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;
interface AiState {
  draft: string;
  messages: AiMessage[];
  history: ConversationTurn[];
  historyError: string;
  clearingHistory: boolean;
  key: AiKeyStatus | null;
  model: AiModel;
  checking: boolean;
  pending: boolean;
  activity: string;
  connectionError: Extract<OrchestratorEvent, { type: "error" }> | null;
  proposals: Record<string, AiProposal>;
  choices: Record<string, AiChoice>;
  refItems: Record<string, ResultItem>;
  navigationErrors: Record<string, string>;
  openingReference: string | null;
  readEnabled: boolean;
  proposalBusy: boolean;
  getProposalAction: (id: string) => RegisteredAction | undefined;
  editProposal: (id: string, draft: unknown) => void;
  confirmProposal: (id: string) => Promise<void>;
  cancelProposal: (id: string) => void;
  transferProposal: (id: string) => Promise<void>;
  openProposalTarget: (id: string) => Promise<void>;
  setProposalScope: (id: string, scope: SeriesScope) => void;
  selectProposal: (id: string, ids: string[]) => void;
  pickCandidate: (id: string, candidateId: string) => Promise<void>;
  openReference: (ref: string) => Promise<void>;
  openLocalTarget: (target: AiTarget, key: string) => Promise<void>;
  invalidateRead: () => void;
  dispose: () => void;
  refresh: () => Promise<void>;
  setDraft: (text: string) => void;
  send: () => Promise<void>;
  clear: () => Promise<boolean>;
}

export function createAiStore(
  api: ConversationApi = aiApi,
  options: {
    now?: () => number;
    newId?: () => string;
    registry?: AiRegistry;
    readPolicy?: AiReadPolicy;
  } = {},
) {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const refs = new MemoryRefTable({ now });
  const registry = options.registry ?? aiRegistry;
  const policy = options.readPolicy ?? aiReadPolicy;
  let readGeneration = 0;
  let unsubscribe = () => undefined as void;
  const orchestrator = new AiOrchestrator({
    client: { chat: api.chat },
    registry,
    refs,
    now,
  });
  let refreshVersion = 0;
  let historyReady = false;
  let historyLoading: Promise<void> | undefined;
  let historyQueue = Promise.resolve();
  const savedIds = new Map<string, string>();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = historyQueue.then(operation);
    historyQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  const store = create<AiState>((set, get) => {
    function loadHistory() {
      const load = api.loadHistory;
      if (!load || historyReady) return;
      historyLoading ??= enqueue(async () => {
        const records = await load();
        const known = new Set(savedIds.values());
        const restored = records
          .filter(({ id }) => !known.has(id))
          .map((record): AiMessage => {
            const base = { id: record.id, createdAt: record.created_at };
            return record.role === "user"
              ? { ...base, role: "user", text: record.text }
              : { ...base, role: "assistant", event: { type: "archived", record } };
          });
        historyReady = true;
        set((state) => ({
          messages: [...restored, ...state.messages].slice(-200),
          historyError: "",
        }));
      })
        .catch(() => set({ historyError: "无法读取本机对话记录，仍可继续对话。" }))
        .finally(() => {
          historyLoading = undefined;
        });
      return historyLoading;
    }
    function saveMessage(message: AiMessage) {
      const appendHistory = api.appendHistory;
      if (!appendHistory) return;
      const input = historyInput(message);
      if (!input) return;
      void enqueue(async () => {
        const saved = await appendHistory(input);
        if (saved) savedIds.set(message.id, saved.id);
      }).catch(() => set({ historyError: "无法保存本机对话记录，仍可继续对话。" }));
    }
    function saveCard(id: string, proposal: AiProposal) {
      const update = api.updateHistoryCard;
      if (!update) return;
      const patch = historyCard(proposal);
      void enqueue(async () => {
        const saved = savedIds.get(id);
        if (saved) await update(saved, patch);
      }).catch(() => set({ historyError: "无法更新本机卡片记录，实际操作结果见卡片。" }));
    }
    const requiresRead = (name: string) =>
      registry.get(name)?.requiresRead === true ||
      [
        "calendar_update_event",
        "calendar_delete_event",
        "reminders_update",
        "reminders_delete",
      ].includes(name);
    const busyState = (proposals: Record<string, AiProposal>, choices = get().choices) =>
      Object.values(proposals).some((item) => ["saving", "transferring"].includes(item.status)) ||
      Object.values(choices).some((item) => item.status === "choosing");
    function updateProposal(id: string, patch: Partial<AiProposal>) {
      const proposal = get().proposals[id];
      if (!proposal) return;
      const updated = { ...proposal, ...patch };
      set((state) => {
        const proposals = { ...state.proposals, [id]: updated };
        return {
          proposals,
          proposalBusy: busyState(proposals),
        };
      });
      if (patch.status && patch.status !== proposal.status) saveCard(id, updated);
    }
    function preparedState(id: string, actionName: string, prepared: Prepared<unknown>) {
      if (prepared.type === "proposal") {
        const proposal: AiProposal = {
          actionName,
          draft: prepared.draft,
          status: "pending",
          errors: [],
          ...(prepared.note ? { note: prepared.note } : {}),
          navigationError: null,
          openingTarget: false,
          needsScope: prepared.needsScope === true,
          ...(prepared.selections ? { selections: prepared.selections } : {}),
          selectedIds: prepared.selections?.map((item) => item.id) ?? [],
          readGeneration,
        };
        return { proposals: { ...get().proposals, [id]: proposal } };
      }
      if (prepared.type === "choose")
        return {
          choices: {
            ...get().choices,
            [id]: {
              actionName,
              prepared,
              status: "pending" as const,
              errors: [],
            },
          },
        };
      return {};
    }
    function append(event: OrchestratorEvent) {
      if (event.type === "status") {
        set({ activity: event.message });
        return;
      }
      const id = newId();
      const message: AiMessage = { id, createdAt: now(), role: "assistant", event };
      set((state) => {
        return {
          messages: [...state.messages, message].slice(-200),
          ...(event.type === "prepared" ? preparedState(id, event.actionName, event.prepared) : {}),
          ...(event.type === "results"
            ? {
                refItems: {
                  ...state.refItems,
                  ...Object.fromEntries(event.items.map((item) => [item.id, item])),
                },
              }
            : {}),
        };
      });
      saveMessage(message);
    }
    return {
      draft: "",
      messages: [],
      history: [],
      historyError: "",
      clearingHistory: false,
      key: null,
      model: DEFAULT_AI_MODEL,
      checking: false,
      pending: false,
      activity: "",
      connectionError: null,
      proposals: {},
      choices: {},
      refItems: {},
      navigationErrors: {},
      openingReference: null,
      readEnabled: policy.isAllowed(),
      proposalBusy: false,
      dispose: () => unsubscribe(),
      invalidateRead: () => {
        readGeneration++;
        refs.clear();
        orchestrator.invalidateRead();
        const message = "你已关闭 AI 读取，依赖读取结果的操作已失效，请重新开启后查询。";
        set((state) => {
          const proposals = Object.fromEntries(
            Object.entries(state.proposals).map(([id, proposal]) => [
              id,
              requiresRead(proposal.actionName) && editable(proposal)
                ? { ...proposal, status: "expired" as const, errors: [message] }
                : proposal,
            ]),
          );
          const choices = Object.fromEntries(
            Object.entries(state.choices).map(([id, choice]) => [
              id,
              choice.status === "pending" || choice.status === "choosing"
                ? { ...choice, status: "expired" as const, errors: [message] }
                : choice,
            ]),
          );
          return {
            readEnabled: false,
            history: [],
            refItems: {},
            proposals,
            choices,
            proposalBusy: busyState(proposals, choices),
          };
        });
      },
      setProposalScope: (id, scope) => {
        const proposal = get().proposals[id];
        if (proposal && editable(proposal) && ["this", "following", "all"].includes(scope))
          updateProposal(id, { scope, errors: [] });
      },
      selectProposal: (id, selectedIds) => {
        const proposal = get().proposals[id];
        const action = proposal && registry.get(proposal.actionName);
        if (!proposal || !editable(proposal) || !proposal.selections || !action?.select) return;
        const allowed = new Set(proposal.selections.map((item) => item.id));
        const ids = [...new Set(selectedIds)].filter((value) => allowed.has(value));
        try {
          updateProposal(id, {
            selectedIds: ids,
            draft: action.select(proposal.draft, ids),
            errors: [],
          });
        } catch (error) {
          updateProposal(id, { errors: [localFailure(error, "选择无效，请重试。")] });
        }
      },
      pickCandidate: async (id, candidateId) => {
        if (get().clearingHistory) return;
        const current = get().choices[id];
        if (
          !current ||
          current.status !== "pending" ||
          !current.prepared.candidates.some((item) => item.id === candidateId)
        )
          return;
        const choice: AiChoice = {
          actionName: current.actionName,
          prepared: current.prepared,
          status: "pending",
          errors: [],
        };
        const generation = readGeneration;
        set((state) => ({
          choices: { ...state.choices, [id]: { ...choice, status: "choosing", errors: [] } },
          proposalBusy: true,
        }));
        try {
          const prepared = await choice.prepared.pick(candidateId);
          if (generation !== readGeneration || !get().readEnabled || !policy.isAllowed()) return;
          if (prepared.type === "error") {
            set((state) => {
              const choices = {
                ...state.choices,
                [id]: {
                  ...choice,
                  status: "pending" as const,
                  errors: [prepared.message],
                  ...(prepared.target ? { target: prepared.target } : {}),
                },
              };
              return { choices, proposalBusy: busyState(state.proposals, choices) };
            });
            return;
          }
          set((state) => {
            const choices = { ...state.choices, [id]: { ...choice, status: "chosen" as const } };
            const next = preparedState(id, choice.actionName, prepared);
            return {
              ...next,
              choices,
              proposalBusy: busyState(next.proposals ?? state.proposals, choices),
            };
          });
        } catch (error) {
          if (generation === readGeneration)
            set((state) => {
              const choices = {
                ...state.choices,
                [id]: {
                  ...choice,
                  status: "pending" as const,
                  errors: [localFailure(error, "无法选择此项，请重新查询。")],
                },
              };
              return { choices, proposalBusy: busyState(state.proposals, choices) };
            });
        }
      },
      openLocalTarget: async (target, key) => {
        set({ openingReference: key });
        set((state) => ({ navigationErrors: { ...state.navigationErrors, [key]: "" } }));
        try {
          if (!api.openTarget) throw new Error("暂时无法打开，请到对应工作台查看。");
          await api.openTarget(target);
        } catch (error) {
          set((state) => ({
            navigationErrors: {
              ...state.navigationErrors,
              [key]: localFailure(error, "无法打开，请重新查询。"),
            },
          }));
        } finally {
          if (get().openingReference === key) set({ openingReference: null });
        }
      },
      openReference: async (ref) => {
        const kind = ref.startsWith("e") ? "event" : "reminder";
        const entry = get().readEnabled && policy.isAllowed() && refs.resolve(ref, kind);
        if (!entry || !get().refItems[ref]) {
          set((state) => ({
            navigationErrors: {
              ...state.navigationErrors,
              [ref]: "引用已过期或读取已关闭，请重新查询。",
            },
          }));
          return;
        }
        await get().openLocalTarget(entry.target, ref);
      },
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
        if (get().clearingHistory) return;
        const proposal = get().proposals[id];
        if (!proposal || !editable(proposal)) return;
        if (proposal.needsScope && !proposal.scope) return;
        if (proposal.selections && !proposal.selectedIds.length) return;
        const readDependent = requiresRead(proposal.actionName);
        if (
          readDependent &&
          (!get().readEnabled || !policy.isAllowed() || proposal.readGeneration !== readGeneration)
        ) {
          updateProposal(id, {
            status: "expired",
            errors: ["读取已关闭或目标已失效，请重新查询。"],
          });
          return;
        }
        // 在任何异步步骤前锁住卡片，双击、重挂载和其他按钮都不能重复写入。
        updateProposal(id, { status: "saving", errors: [], navigationError: null });
        await Promise.resolve();
        try {
          if (
            readDependent &&
            (proposal.readGeneration !== readGeneration || !policy.isAllowed())
          ) {
            updateProposal(id, { status: "expired", errors: ["你已关闭 AI 读取，此操作已失效。"] });
            return;
          }
          const action = registry.get(proposal.actionName);
          if (action?.kind !== "write" || !action.validate || !action.execute)
            throw new Error("此操作当前不可用，请重新发起或手动新建。");
          const errors = action.validate(proposal.draft);
          if (errors.length) {
            updateProposal(id, { status: "pending", errors });
            return;
          }
          const result = proposal.scope
            ? await action.execute(proposal.draft, proposal.scope)
            : await action.execute(proposal.draft);
          updateProposal(id, { status: "saved", result });
        } catch (error) {
          updateProposal(id, {
            status: "failed",
            errors: [localFailure(error, "保存未完成，请重试。")],
          });
        } finally {
          await historyQueue;
        }
      },
      cancelProposal: (id) => {
        const proposal = get().proposals[id];
        if (proposal && editable(proposal))
          updateProposal(id, { status: "cancelled", errors: [], navigationError: null });
      },
      transferProposal: async (id) => {
        if (get().clearingHistory) return;
        const proposal = get().proposals[id];
        if (!proposal || !editable(proposal) || requiresRead(proposal.actionName)) return;
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
        const history = loadHistory();
        const version = ++refreshVersion;
        const generation = readGeneration;
        set({ checking: true, connectionError: null });
        try {
          const [key, model, readEnabled] = await Promise.all([
            api.keyStatus(),
            api.loadModel(),
            api.loadReadEnabled?.() ?? policy.isAllowed(),
          ]);
          if (generation === readGeneration && !readEnabled && get().readEnabled)
            get().invalidateRead();
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
          await history;
          if (version === refreshVersion) set({ checking: false });
        }
      },
      send: async () => {
        if (get().pending || get().clearingHistory) return;
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
        set({
          pending: true,
          activity: "正在理解…",
          draft: "",
          connectionError: null,
        });
        await loadHistory();
        const message: AiMessage = { id: newId(), createdAt: now(), role: "user", text };
        set((state) => ({ messages: [...state.messages, message].slice(-200) }));
        saveMessage(message);
        try {
          const configGeneration = readGeneration;
          const [key, model, readEnabled, stepLimitEnabled] = await Promise.all([
            api.keyStatus(),
            api.loadModel(),
            api.loadReadEnabled?.() ?? policy.isAllowed(),
            api.loadStepLimitEnabled?.() ?? true,
          ]);
          if (configGeneration === readGeneration && !readEnabled && get().readEnabled)
            get().invalidateRead();
          set({ key, model });
          if (!key.configured) throw new AiClientError("KEY_MISSING");
          const generation = readGeneration;
          const allowed = get().readEnabled && policy.isAllowed();
          const result = await orchestrator.run({
            text,
            history: get().history,
            model,
            readEnabled: allowed,
            stepLimitEnabled,
            isReadAllowed: () =>
              generation === readGeneration && get().readEnabled && policy.isAllowed(),
            onEvent: (event) => {
              if (
                generation !== readGeneration &&
                (event.type === "results" ||
                  event.type === "text" ||
                  (event.type === "prepared" && requiresRead(event.actionName)))
              )
                return;
              append(event);
            },
          });
          if (generation === readGeneration)
            set((state) => ({
              history: [
                ...state.history.map((turn) => ({ ...turn, exchanges: [] })),
                result.turn,
              ].slice(-6),
            }));
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
          await historyQueue;
          set({ pending: false, activity: "" });
        }
      },
      clear: async () => {
        if (get().pending || get().proposalBusy || get().clearingHistory) return false;
        set({ clearingHistory: true, historyError: "" });
        try {
          if (api.clearHistory) await enqueue(api.clearHistory);
          historyReady = true;
          savedIds.clear();
          refs.clear();
          set({
            messages: [],
            history: [],
            proposals: {},
            choices: {},
            refItems: {},
            navigationErrors: {},
            connectionError: null,
            historyError: "",
          });
          return true;
        } catch {
          set({ historyError: "无法清空本机对话记录，请重试。" });
          return false;
        } finally {
          set({ clearingHistory: false });
        }
      },
    };
  });
  unsubscribe = policy.subscribe((allowed) => {
    if (allowed) store.setState({ readEnabled: true });
    else store.getState().invalidateRead();
  });
  return store;
}
export type AiStore = ReturnType<typeof createAiStore>;
export const useAiStore = createAiStore();
