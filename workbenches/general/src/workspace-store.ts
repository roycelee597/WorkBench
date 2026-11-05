import { create } from "zustand";
import {
  filterMemos,
  generalApi,
  type GeneralApi,
  type Memo,
  type MemoDraft,
  type Theme,
} from "./api";
import { MemoAutosave, type SaveStatus } from "./memo-autosave";

export type Page = "today" | "memos" | "calendar" | "reminders" | "settings" | "trash";
interface WorkspaceState {
  ready: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
  page: Page;
  memos: Memo[];
  deleted: Memo[];
  selectedId: string | null;
  query: string;
  tag: string;
  theme: Theme;
  saveStatus: SaveStatus;
  initialize: () => Promise<void>;
  navigate: (page: Page) => Promise<void>;
  selectMemo: (id: string) => Promise<void>;
  createMemo: () => Promise<void>;
  editMemo: (id: string, patch: Partial<MemoDraft>) => void;
  deleteMemo: (id: string) => Promise<void>;
  restoreMemo: (id: string) => Promise<void>;
  purgeMemo: (id: string) => Promise<void>;
  refreshTrash: () => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
  setQuery: (query: string) => void;
  setTag: (tag: string) => void;
}
const draftOf = (memo: Memo): MemoDraft => ({
  title: memo.title,
  content: memo.content,
  pinned: memo.pinned,
  tags: [...memo.tags],
});

export function createWorkspace(api: GeneralApi) {
  let initialization: Promise<void> | undefined;
  const useWorkspace = create<WorkspaceState>((set, get) => {
    async function refresh() {
      const result = await api.load();
      set((state) => ({
        ...result,
        ready: true,
        selectedId: result.memos.some((row) => row.id === state.selectedId)
          ? state.selectedId
          : (result.memos[0]?.id ?? null),
      }));
    }
    async function action(run: () => Promise<void>) {
      if (get().busy) return;
      set({ busy: true, error: null });
      try {
        await run();
      } catch (error) {
        console.error("工作台操作失败", error);
        set({ error: "操作未完成，你的修改仍保留在当前窗口。请重试。" });
      } finally {
        set({ busy: false });
      }
    }
    return {
      ready: false,
      loading: false,
      busy: false,
      error: null,
      page: "today",
      memos: [],
      deleted: [],
      selectedId: null,
      query: "",
      tag: "",
      theme: "system",
      saveStatus: "saved",
      initialize: () => {
        initialization ??= (async () => {
          set({ loading: true, error: null });
          try {
            await refresh();
          } catch (error) {
            initialization = undefined;
            console.error("打开综合工作台失败", error);
            set({ error: "未能读取本地内容，请重试。" });
          } finally {
            set({ loading: false });
          }
        })();
        return initialization;
      },
      navigate: (page) =>
        action(async () => {
          await queue.flush();
          if (page === "trash") set({ deleted: await api.listDeleted() });
          set({ page });
        }),
      selectMemo: (id) =>
        action(async () => {
          await queue.flush();
          set({ selectedId: id });
        }),
      createMemo: () =>
        action(async () => {
          await queue.flush();
          const memo = await api.createMemo();
          set((state) => ({
            memos: filterMemos([...state.memos, memo]),
            selectedId: memo.id,
            page: "memos",
            query: "",
            tag: "",
          }));
        }),
      editMemo: (id, patch) => {
        const current = get().memos.find((memo) => memo.id === id);
        if (!current || get().busy) return;
        const updated = { ...current, ...patch };
        set((state) => ({ memos: state.memos.map((memo) => (memo.id === id ? updated : memo)) }));
        queue.schedule(id, draftOf(updated));
      },
      deleteMemo: (id) =>
        action(async () => {
          await queue.flush();
          await api.deleteMemo(id);
          await refresh();
        }),
      restoreMemo: (id) =>
        action(async () => {
          await queue.flush();
          await api.restoreMemo(id);
          await refresh();
        }),
      purgeMemo: (id) =>
        action(async () => {
          await api.purgeMemo(id);
          set({ deleted: await api.listDeleted() });
        }),
      refreshTrash: async () => {
        try {
          set({ deleted: await api.listDeleted() });
        } catch (error) {
          console.error("刷新回收站失败", error);
        }
      },
      setTheme: (theme) =>
        action(async () => {
          await api.setTheme(theme);
          set({ theme });
        }),
      setQuery: (query) => set({ query }),
      setTag: (tag) => set({ tag }),
    };
  });
  const queue = new MemoAutosave({
    save: api.saveMemo,
    saved: (saved, newerDraft) =>
      useWorkspace.setState((state) => ({
        memos: filterMemos(
          state.memos.map((memo) =>
            memo.id === saved.id ? { ...saved, ...(newerDraft ? draftOf(memo) : {}) } : memo,
          ),
        ),
      })),
    status: (saveStatus, error) => {
      useWorkspace.setState({ saveStatus });
      if (error) console.error("保存备忘录失败", error);
    },
  });
  return { useWorkspace, flush: () => queue.flush() };
}
export const workspace = createWorkspace(generalApi);
