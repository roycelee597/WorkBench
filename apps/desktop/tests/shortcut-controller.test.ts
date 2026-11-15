import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHORTCUT,
  DEFAULT_AI_SHORTCUT,
  ShortcutController,
  ShortcutCoordinator,
  normalizeShortcut,
  type ShortcutPort,
} from "../src/core/shortcut-controller";
function setup() {
  const registered = new Map<string, () => void>();
  let stored = DEFAULT_SHORTCUT;
  const port: ShortcutPort = {
    register: vi.fn(async (key, callback) => {
      if (registered.has(key)) throw new Error("冲突");
      registered.set(key, callback);
    }),
    unregister: vi.fn(async (key) => {
      registered.delete(key);
    }),
    load: async () => stored,
    persist: vi.fn(async (key) => {
      stored = key;
    }),
    open: vi.fn(async () => undefined),
  };
  const controller = new ShortcutController(port);
  return { port, controller, registered, stored: () => stored };
}
describe("全局快捷键", () => {
  it("规范化并拒绝无修饰键、重复键及系统关闭组合", () => {
    expect(normalizeShortcut(" shift + control + alt + n ")).toBe("Ctrl+Alt+Shift+N");
    expect(normalizeShortcut("Alt+F10")).toBe("Alt+F10");
    expect(normalizeShortcut("ctrl + alt + space")).toBe(DEFAULT_AI_SHORTCUT);
    expect(normalizeShortcut("shift + control + space")).toBe("Ctrl+Shift+Space");
    expect(normalizeShortcut("Ctrl+Alt+Shift+Space")).toBe("Ctrl+Alt+Shift+Space");
    for (const value of [
      "N",
      "Shift+N",
      "Ctrl+Ctrl+N",
      "Alt+F4",
      "Ctrl+Alt+Delete",
      "Win+N",
      "Ctrl+N+M",
      "Space",
      "Ctrl+Space",
      "Alt+Space",
      "Shift+Space",
      "Alt+Shift+Space",
    ])
      expect(() => normalizeShortcut(value)).toThrow();
  });
  it("默认只注册一次，触发打开快速窗口，停止会释放", async () => {
    const { controller, port, registered } = setup();
    await Promise.all([controller.start(), controller.start()]);
    expect(port.register).toHaveBeenCalledOnce();
    registered.get(DEFAULT_SHORTCUT)!();
    expect(port.open).toHaveBeenCalledOnce();
    await controller.stop();
    expect(registered.size).toBe(0);
  });
  it("新组合冲突时原组合继续有效，不持久化失败值", async () => {
    const { controller, port, registered, stored } = setup();
    await controller.start();
    registered.set("Ctrl+Shift+N", () => undefined);
    await expect(controller.configure("Ctrl+Shift+N")).rejects.toThrow("冲突");
    expect(controller.getStatus()).toMatchObject({
      active: DEFAULT_SHORTCUT,
      configured: DEFAULT_SHORTCUT,
    });
    expect(stored()).toBe(DEFAULT_SHORTCUT);
    expect(port.persist).not.toHaveBeenCalled();
  });
  it("保存配置失败撤销新组合，成功改键后旧组合释放且可重启恢复", async () => {
    const { controller, port, registered, stored } = setup();
    await controller.start();
    vi.mocked(port.persist).mockRejectedValueOnce(new Error("数据库失败"));
    await expect(controller.configure("Ctrl+Shift+N")).rejects.toThrow("保留原快捷键");
    expect([...registered.keys()]).toEqual([DEFAULT_SHORTCUT]);
    await controller.configure("Ctrl+Shift+N");
    expect([...registered.keys()]).toEqual(["Ctrl+Shift+N"]);
    expect(stored()).toBe("Ctrl+Shift+N");
    await controller.stop();
    const restarted = new ShortcutController(port);
    await restarted.start();
    expect(restarted.getStatus().active).toBe("Ctrl+Shift+N");
  });
  it("启动冲突仍可在设置改键恢复，异常唤起有错误提示", async () => {
    const { controller, registered, port } = setup();
    registered.set(DEFAULT_SHORTCUT, () => undefined);
    await controller.start();
    expect(controller.getStatus()).toMatchObject({
      active: null,
      error: expect.stringContaining("占用"),
    });
    await controller.configure("Ctrl+Alt+F10");
    vi.mocked(port.open).mockRejectedValueOnce(new Error("窗口错误"));
    registered.get("Ctrl+Alt+F10")!();
    await Promise.resolve();
    expect(controller.getStatus().error).toContain("打开快速新建");
  });
  it("停止后同一个控制器可重新启动，配置原组合返回当前状态", async () => {
    const { controller, port } = setup();
    await controller.start();
    expect(await controller.configure(DEFAULT_SHORTCUT)).toMatchObject({
      active: DEFAULT_SHORTCUT,
    });
    await controller.stop();
    await controller.start();
    expect(controller.getStatus().active).toBe(DEFAULT_SHORTCUT);
    expect(port.register).toHaveBeenCalledTimes(2);
  });
});

function setupPair(aiStored = DEFAULT_AI_SHORTCUT) {
  const coordinator = new ShortcutCoordinator();
  const registered = new Map<string, () => void>();
  const makePort = (initial: string): ShortcutPort => {
    let stored = initial;
    return {
      register: vi.fn(async (key, pressed) => {
        if (registered.has(key)) throw new Error("系统冲突");
        registered.set(key, pressed);
      }),
      unregister: vi.fn(async (key) => {
        registered.delete(key);
      }),
      load: vi.fn(async () => stored),
      persist: vi.fn(async (key) => {
        stored = key;
      }),
      open: vi.fn(async () => undefined),
    };
  };
  const quickPort = makePort(DEFAULT_SHORTCUT);
  const aiPort = makePort(aiStored);
  const quick = new ShortcutController(quickPort, undefined, { coordinator, label: "快速新建" });
  const ai = new ShortcutController(aiPort, undefined, {
    coordinator,
    label: "AI 助手",
    defaultShortcut: DEFAULT_AI_SHORTCUT,
    openError: "未能打开 AI 助手，请重试。",
  });
  return { quick, ai, quickPort, aiPort, registered };
}

describe("快速新建和 AI 快捷键互斥", () => {
  it("启动读到重复设置时保留先注册的一方，明确提示冲突功能", async () => {
    const { quick, ai, aiPort } = setupPair(DEFAULT_SHORTCUT);
    await Promise.all([quick.start(), ai.start()]);
    expect(quick.getStatus().active).toBe(DEFAULT_SHORTCUT);
    expect(ai.getStatus()).toMatchObject({
      active: null,
      error: expect.stringContaining("快速新建"),
    });
    expect(aiPort.register).not.toHaveBeenCalled();
    await ai.configure(DEFAULT_AI_SHORTCUT);
    expect(ai.getStatus().active).toBe(DEFAULT_AI_SHORTCUT);
  });
  it("双向改键均先检查另一功能，注册和配置不会被覆盖", async () => {
    const { quick, ai, registered, quickPort, aiPort } = setupPair();
    await Promise.all([quick.start(), ai.start()]);
    await expect(quick.configure(DEFAULT_AI_SHORTCUT)).rejects.toThrow("AI 助手");
    await expect(ai.configure(DEFAULT_SHORTCUT)).rejects.toThrow("快速新建");
    expect([...registered.keys()]).toEqual([DEFAULT_SHORTCUT, DEFAULT_AI_SHORTCUT]);
    expect(quickPort.persist).not.toHaveBeenCalled();
    expect(aiPort.persist).not.toHaveBeenCalled();
  });
  it("两个并发改键通过同一队列，后改的一方不会取消先改的新绑定", async () => {
    const { quick, ai, registered } = setupPair();
    await Promise.all([quick.start(), ai.start()]);
    const changes = await Promise.allSettled([
      quick.configure("Ctrl+Alt+F8"),
      ai.configure("Ctrl+Alt+F8"),
    ]);
    expect(changes.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect([...registered.keys()]).toEqual([DEFAULT_AI_SHORTCUT, "Ctrl+Alt+F8"]);
    expect(quick.getStatus().active).toBe("Ctrl+Alt+F8");
    expect(ai.getStatus().active).toBe(DEFAULT_AI_SHORTCUT);
  });
  it("AI 保存失败只撤销 AI 新组合，快速新建和原 AI 组合仍可触发", async () => {
    const { quick, ai, registered, aiPort, quickPort } = setupPair();
    await Promise.all([quick.start(), ai.start()]);
    vi.mocked(aiPort.persist).mockRejectedValueOnce(new Error("设置写盘失败"));
    await expect(ai.configure("Ctrl+Shift+Space")).rejects.toThrow("保留原快捷键");
    expect([...registered.keys()]).toEqual([DEFAULT_SHORTCUT, DEFAULT_AI_SHORTCUT]);
    registered.get(DEFAULT_SHORTCUT)!();
    registered.get(DEFAULT_AI_SHORTCUT)!();
    expect(quickPort.open).toHaveBeenCalledOnce();
    expect(aiPort.open).toHaveBeenCalledOnce();
    vi.mocked(aiPort.open).mockRejectedValueOnce(new Error("打开失败"));
    registered.get(DEFAULT_AI_SHORTCUT)!();
    await Promise.resolve();
    expect(ai.getStatus().error).toContain("AI 助手");
    expect(quick.getStatus().error).toBeNull();
  });
  it("AI 释放旧组合失败会撤销新组合并恢复已保存配置，可再次改键", async () => {
    const { quick, ai, registered, aiPort } = setupPair();
    await Promise.all([quick.start(), ai.start()]);
    vi.mocked(aiPort.unregister).mockRejectedValueOnce(new Error("释放失败"));
    await expect(ai.configure("Ctrl+Shift+Space")).rejects.toThrow("保留原快捷键");
    expect([...registered.keys()]).toEqual([DEFAULT_SHORTCUT, DEFAULT_AI_SHORTCUT]);
    expect(aiPort.persist).toHaveBeenNthCalledWith(1, "Ctrl+Shift+Space");
    expect(aiPort.persist).toHaveBeenNthCalledWith(2, DEFAULT_AI_SHORTCUT);
    expect(ai.getStatus().active).toBe(DEFAULT_AI_SHORTCUT);
    await ai.configure("Ctrl+Shift+Space");
    expect(ai.getStatus()).toMatchObject({ active: "Ctrl+Shift+Space", error: null });
  });
});
