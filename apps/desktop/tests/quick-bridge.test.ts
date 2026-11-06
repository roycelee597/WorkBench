import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  quickCreate: vi.fn(),
  preferences: vi.fn(),
  accept: vi.fn(),
  request: null as null | (() => void),
  messages: [] as unknown[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mock.listen }));
vi.mock("@workbench/general", () => ({
  generalApi: { quickCreate: mock.quickCreate, quickPreferences: mock.preferences },
  workspace: {
    acceptCreatedMemo: mock.accept,
    useWorkspace: { getState: () => ({ autostartOffer: false }) },
  },
}));
const id = "019a5555-1234-7123-8123-123456789abc";
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mock.messages = [];
  mock.request = null;
  mock.listen.mockImplementation(async (_event: string, listener: () => void) => {
    mock.request = listener;
    return () => undefined;
  });
  mock.invoke.mockImplementation(async (command: string) =>
    command === "take_quick_requests" ? mock.messages.splice(0) : undefined,
  );
});
describe("快速新建主窗口消息桥", () => {
  it("非法字段、未知请求与伪造输入在调用数据层前拒绝", async () => {
    mock.messages.push({
      id,
      payload: {
        type: "create",
        input: { type: "memo", title: "测试", content: "", source_workbench: "evil" },
      },
    });
    const { initializeQuickHost } = await import("../src/shell/quick-bridge");
    await initializeQuickHost();
    expect(mock.quickCreate).not.toHaveBeenCalled();
    expect(mock.invoke).toHaveBeenCalledWith(
      "finish_quick_request",
      expect.objectContaining({ id, result: expect.objectContaining({ ok: false }) }),
    );
  });
  it("先监听再接收队列中的合法保存，仅追加新备忘录并只返回记录 id", async () => {
    const record = { id: "new-id", title: "保存", content: "正文" };
    mock.quickCreate.mockResolvedValue({ type: "memo", record });
    mock.messages.push({
      id,
      payload: { type: "create", input: { type: "memo", title: "保存", content: "正文" } },
    });
    const { initializeQuickHost } = await import("../src/shell/quick-bridge");
    await Promise.all([initializeQuickHost(), initializeQuickHost()]);
    expect(mock.listen).toHaveBeenCalledOnce();
    expect(mock.quickCreate).toHaveBeenCalledOnce();
    expect(mock.accept).toHaveBeenCalledWith(record);
    expect(mock.invoke).toHaveBeenCalledWith("finish_quick_request", {
      id,
      result: { ok: true, data: { type: "memo", id: "new-id" } },
    });
  });
  it("仓库错误转为失败响应，后续请求仍继续处理", async () => {
    mock.quickCreate.mockRejectedValueOnce(new Error("存储不可用"));
    mock.preferences.mockResolvedValue({ theme: "dark", defaultReminder: null });
    mock.messages.push(
      { id, payload: { type: "create", input: { type: "memo", title: "保存", content: "" } } },
      { id: "019a5555-1234-7123-8123-123456789abd", payload: { type: "preferences" } },
    );
    const { initializeQuickHost } = await import("../src/shell/quick-bridge");
    await initializeQuickHost();
    expect(mock.invoke).toHaveBeenCalledWith("finish_quick_request", {
      id,
      result: { ok: false, error: "存储不可用" },
    });
    expect(mock.preferences).toHaveBeenCalledOnce();
  });
});
