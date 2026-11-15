import { invoke } from "@tauri-apps/api/core";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { generalApi, workspace } from "@workbench/general";
import { aiApi } from "@workbench/ai";
import {
  DEFAULT_AI_SHORTCUT,
  ShortcutController,
  ShortcutCoordinator,
  type ShortcutStatus,
} from "../core/shortcut-controller";

const coordinator = new ShortcutCoordinator();
let openAi: (() => Promise<void>) | undefined;
let aiStatus: ShortcutStatus = { configured: DEFAULT_AI_SHORTCUT, active: null, error: null };
const aiListeners = new Set<() => void>();

export function configureAiShortcutOpening(open: () => Promise<void>) {
  openAi = open;
  return () => {
    if (openAi === open) openAi = undefined;
  };
}
export function subscribeAiShortcutStatus(listener: () => void) {
  aiListeners.add(listener);
  return () => aiListeners.delete(listener);
}
export function getAiShortcutStatus() {
  return aiStatus;
}

export const shortcutController = new ShortcutController(
  {
    register: (shortcut, pressed) =>
      register(shortcut, (event) => {
        if (event.state === "Pressed") pressed();
      }),
    unregister,
    load: () => generalApi.getStoredShortcut(),
    persist: (value) => generalApi.setStoredShortcut(value),
    open: () => invoke("open_quick_create"),
  },
  (status) => workspace.useWorkspace.setState({ shortcutError: status.error }),
  { coordinator, label: "快速新建" },
);
export const aiShortcutController = new ShortcutController(
  {
    register: (shortcut, pressed) =>
      register(shortcut, (event) => {
        if (event.state === "Pressed") pressed();
      }),
    unregister,
    load: () => aiApi.getStoredShortcut(),
    persist: (value) => aiApi.setStoredShortcut(value),
    open: async () => {
      if (!openAi) throw new Error("AI 助手尚未就绪");
      await openAi();
    },
  },
  (status) => {
    aiStatus = status;
    for (const listener of aiListeners) listener();
  },
  {
    coordinator,
    label: "AI 助手",
    defaultShortcut: DEFAULT_AI_SHORTCUT,
    openError: "未能打开 AI 助手，请重试。",
  },
);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    void shortcutController.stop().catch(console.error);
    void aiShortcutController.stop().catch(console.error);
  });
