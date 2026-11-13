// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FinanceSettings } from "./FinanceSettings";

const state = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), busy: false }));
vi.mock("./api", () => ({
  financeApi: { loadFallback: state.load, saveFallback: state.save },
  displayFinanceError: (error: unknown) => (error instanceof Error ? error.message : "操作失败"),
  useFinanceState: (select: (value: { token: null; error: null }) => unknown) =>
    select({ token: null, error: null }),
  useFinanceCache: () => ({}),
  useFinanceUpdate: () => ({ status: state.busy ? "running" : "idle" }),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.load.mockReset().mockResolvedValue(true);
  state.save.mockReset().mockResolvedValue(undefined);
  state.busy = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("备用源开关加载后可关闭，保存失败时保留原状态并报告错误", async () => {
  await act(async () => root.render(<FinanceSettings />));
  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(checkbox.checked).toBe(true);
  expect(container.textContent).toContain("默认安装包不含该组件");
  await act(async () => checkbox.click());
  expect(state.save).toHaveBeenCalledWith(false);
  expect(checkbox.checked).toBe(false);
  state.save.mockRejectedValueOnce(new Error("模拟设置写入失败"));
  await act(async () => checkbox.click());
  expect(checkbox.checked).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("模拟设置写入失败");
});

it("引擎运行时不修改本次运行的备用选项", async () => {
  state.busy = true;
  await act(async () => root.render(<FinanceSettings />));
  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(checkbox.disabled).toBe(true);
  await act(async () => checkbox.click());
  expect(state.save).not.toHaveBeenCalled();
});
