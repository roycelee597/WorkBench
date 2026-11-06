import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHORTCUT,
  ShortcutController,
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
    for (const value of [
      "N",
      "Shift+N",
      "Ctrl+Ctrl+N",
      "Alt+F4",
      "Ctrl+Alt+Delete",
      "Win+N",
      "Ctrl+N+M",
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
});
