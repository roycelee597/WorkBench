import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_SHORTCUT, DEFAULT_SHORTCUT } from "../src/core/shortcut-controller";
import {
  aiShortcutController,
  configureAiShortcutOpening,
  getAiShortcutStatus,
  shortcutController,
  subscribeAiShortcutStatus,
} from "../src/shell/shortcut-runtime";

const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  setQuickError: vi.fn(),
  persistQuick: vi.fn(),
  persistAi: vi.fn(),
  registrations: new Map<string, (event: { state: "Pressed" | "Released" }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: vi.fn(
    async (key: string, pressed: (event: { state: "Pressed" | "Released" }) => void) => {
      if (mock.registrations.has(key)) throw new Error("快捷键已注册");
      mock.registrations.set(key, pressed);
    },
  ),
  unregister: vi.fn(async (key: string) => {
    mock.registrations.delete(key);
  }),
}));
vi.mock("@workbench/general", () => ({
  generalApi: { getStoredShortcut: async () => "Ctrl+Alt+N", setStoredShortcut: mock.persistQuick },
  workspace: { useWorkspace: { setState: mock.setQuickError } },
}));
vi.mock("@workbench/ai", () => ({
  aiApi: { getStoredShortcut: async () => "Ctrl+Alt+Space", setStoredShortcut: mock.persistAi },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  mock.invoke.mockResolvedValue(undefined);
  mock.persistAi.mockResolvedValue(undefined);
  mock.persistQuick.mockResolvedValue(undefined);
  await Promise.all([shortcutController.start(), aiShortcutController.start()]);
});
afterEach(async () => {
  await Promise.all([shortcutController.stop(), aiShortcutController.stop()]);
});

describe("桌面快捷键接线", () => {
  it("按下快速新建调用独立窗口，AI 使用 Shell 回调，松开不会再触发", async () => {
    const openAi = vi.fn(async () => undefined);
    const off = configureAiShortcutOpening(openAi);
    mock.registrations.get(DEFAULT_SHORTCUT)!({ state: "Released" });
    mock.registrations.get(DEFAULT_AI_SHORTCUT)!({ state: "Released" });
    expect(mock.invoke).not.toHaveBeenCalled();
    expect(openAi).not.toHaveBeenCalled();
    mock.registrations.get(DEFAULT_SHORTCUT)!({ state: "Pressed" });
    mock.registrations.get(DEFAULT_AI_SHORTCUT)!({ state: "Pressed" });
    await Promise.resolve();
    expect(mock.invoke).toHaveBeenCalledWith("open_quick_create");
    expect(openAi).toHaveBeenCalledOnce();
    off();
  });
  it("AI 改键保存通过 AI api，冲突不会污染快速新建错误状态", async () => {
    const updated = vi.fn();
    const off = subscribeAiShortcutStatus(updated);
    mock.setQuickError.mockClear();
    await expect(aiShortcutController.configure(DEFAULT_SHORTCUT)).rejects.toThrow("快速新建");
    expect(getAiShortcutStatus().error).toContain("快速新建");
    expect(updated).toHaveBeenCalled();
    expect(mock.setQuickError).not.toHaveBeenCalled();
    await aiShortcutController.configure("Ctrl+Shift+Space");
    expect(mock.persistAi).toHaveBeenCalledWith("Ctrl+Shift+Space");
    expect(mock.persistQuick).not.toHaveBeenCalled();
    expect(getAiShortcutStatus().error).toBeNull();
    off();
  });
  it("卸载旧 Shell 回调不会移除新回调；唤起失败只显示 AI 的错误", async () => {
    const old = configureAiShortcutOpening(vi.fn(async () => undefined));
    const openAi = vi.fn(async () => {
      throw new Error("保存失败");
    });
    const current = configureAiShortcutOpening(openAi);
    old();
    mock.setQuickError.mockClear();
    mock.registrations.get(DEFAULT_AI_SHORTCUT)!({ state: "Pressed" });
    await vi.waitFor(() => {
      expect(getAiShortcutStatus().error).toContain("打开 AI 助手");
    });
    expect(openAi).toHaveBeenCalledOnce();
    expect(mock.setQuickError).not.toHaveBeenCalled();
    current();
  });
});
