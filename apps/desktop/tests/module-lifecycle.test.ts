import { beforeEach, expect, it, vi } from "vitest";
import { generalModuleId, moduleApi, sequenceModuleWrite } from "../src/runtime/module-api";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), purge: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../src/core/repositories/initialize", () => ({
  initializeDataLayer: async () => ({ moduleCleanup: { purgeSharedData: mocks.purge } }),
}));

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.purge.mockReset();
});

it("重启时继续清理，仓库清理成功后才移除待清理记录", async () => {
  const id = "com.example.timer";
  let pending = [id];
  mocks.invoke.mockImplementation(async (command: string, parameters?: { id: string }) => {
    if (command === "module_list") return { modules: [], pending: [...pending] };
    if (command === "module_finish_uninstall")
      pending = pending.filter((id) => id !== parameters?.id);
  });
  mocks.purge.mockRejectedValueOnce(new Error("模拟清理中断")).mockResolvedValueOnce(undefined);

  expect(await moduleApi.start()).toEqual({ modules: [], pending: [id] });
  expect(mocks.invoke).not.toHaveBeenCalledWith("module_finish_uninstall", { id });
  expect(await moduleApi.start()).toEqual({ modules: [], pending: [] });
  expect(mocks.purge.mock.calls).toEqual([[id], [id]]);
  expect(mocks.invoke).toHaveBeenCalledWith("module_finish_uninstall", { id });
});

it("卸载等待正在执行的事务，拒绝排队和后续写入", async () => {
  const id = "com.example.queued-timer";
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = vi.fn(() => pending);
  const write = sequenceModuleWrite(id, started);
  await vi.waitFor(() => expect(started).toHaveBeenCalled());
  const queued = vi.fn(async () => undefined);
  const waiting = expect(sequenceModuleWrite(id, queued)).rejects.toThrow("正在卸载");
  const cleanup = moduleApi.uninstall(id);
  await expect(sequenceModuleWrite(id, queued)).rejects.toThrow("正在卸载");
  expect(mocks.invoke).not.toHaveBeenCalled();
  release();
  await write;
  await waiting;
  await cleanup;
  expect(queued).not.toHaveBeenCalled();
  await expect(sequenceModuleWrite(id, queued)).rejects.toThrow("正在卸载");
  expect(mocks.invoke.mock.calls).toEqual([
    ["uninstall_module", { id }],
    ["module_finish_uninstall", { id }],
  ]);
  expect(mocks.purge).toHaveBeenCalledWith(id);
  await expect(moduleApi.uninstall(generalModuleId)).rejects.toThrow("不可卸载");
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});
