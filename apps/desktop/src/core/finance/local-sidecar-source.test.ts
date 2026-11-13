// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { parseEngineEvent } from "./engine-events";
import { FinanceReader } from "./finance-reader";
import { LocalSidecarSource } from "./local-sidecar-source";
import { scheduleFinanceStartupUpdate } from "./startup-update";

function harness(result: "started" | "already_running" = "started") {
  let listener: (value: unknown) => void = () => undefined;
  const start = vi.fn(async () => result);
  const reader = new FinanceReader();
  const resume = vi.spyOn(reader, "resume");
  const suspend = vi.spyOn(reader, "suspendForRebuild");
  const source = new LocalSidecarSource(reader, {
    start,
    subscribe: async (callback) => {
      listener = callback;
      return () => undefined;
    },
  });
  return {
    source,
    start,
    resume,
    suspend,
    send: (value: object) => listener(JSON.stringify(value)),
  };
}

describe("金融引擎协议和更新状态", () => {
  it("把显式关闭备用源的选项传给原生启动命令", async () => {
    const { source, start } = harness();
    await source.requestUpdate("auto", false);
    expect(start).toHaveBeenCalledWith("auto", false);
  });
  it("校验交易日期和进度，忽略损坏的 NDJSON", () => {
    const progress = {
      type: "progress",
      stage: "recent",
      done: 1,
      total: 65,
      current: "20261106",
      eta_seconds: 60,
    };
    expect(parseEngineEvent(JSON.stringify(progress))).toEqual(progress);
    expect(parseEngineEvent(JSON.stringify({ ...progress, done: 66 }))).toBeUndefined();
    expect(
      parseEngineEvent(JSON.stringify({ ...progress, current: "2026-11-06" })),
    ).toBeUndefined();
    expect(parseEngineEvent("{失效")).toBeUndefined();
  });

  it.each([
    ["ok", "complete"],
    ["partial", "partial"],
  ] as const)("处理 done %s", async (outcome, state) => {
    const { source, start, send } = harness();
    const listener = vi.fn();
    const off = source.onEvent(listener);
    expect(source.getSnapshot().status).toBe("idle");
    await source.requestUpdate();
    await source.requestUpdate();
    expect(start).toHaveBeenCalledTimes(1);
    const stage = { type: "stage", stage: "recent" };
    send(stage);
    expect(listener).toHaveBeenLastCalledWith(stage);
    send({ type: "done", status: outcome, new_dates: {}, through: {} });
    expect(source.getSnapshot().status).toBe("running");
    send({ type: "engine_exit", code: 0, cancelled: false });
    expect(source.getSnapshot().status).toBe(state);
    off();
  });

  it("收到重复启动、引擎错误与异常退出时能恢复", async () => {
    const { source, send } = harness("already_running");
    await source.requestUpdate();
    expect(source.getSnapshot().status).toBe("already_running");
    send({ type: "error", code: "NETWORK", message: "网络不可用", retryable: true });
    send({ type: "engine_exit", code: 4, cancelled: false });
    expect(source.getSnapshot()).toMatchObject({
      status: "failed",
      diagnostic: { code: "NETWORK" },
    });
  });

  it("重建前关闭读取，取消后恢复读取", async () => {
    const { source, suspend, resume, send } = harness();
    await source.requestUpdate("full-rebuild");
    expect(suspend).toHaveBeenCalledOnce();
    send({ type: "engine_exit", code: 1, cancelled: true });
    expect(resume).toHaveBeenCalledOnce();
    expect(source.getSnapshot().status).toBe("idle");
  });

  it.each([
    { status: "ok", code: 0, cancelled: false },
    { status: "partial", code: 0, cancelled: false },
    { status: "failed", code: 4, cancelled: false },
    { status: undefined, code: 130, cancelled: true },
    { status: undefined, code: null, cancelled: false },
  ])("所有退出均触发评估，退出状态为 $status / $code", async ({ status, code, cancelled }) => {
    const { source, send } = harness();
    const callback = vi.fn();
    const off = source.onExit(callback);
    await source.requestUpdate();
    if (status) send({ type: "done", status, new_dates: {}, through: {} });
    expect(callback).not.toHaveBeenCalled();
    send({ type: "engine_exit", code, cancelled });
    expect(callback).toHaveBeenCalledExactlyOnceWith("auto");
    off();
  });

  it("取消的完整重建仍通知静默重设，下一轮恢复自动模式", async () => {
    const { source, send } = harness();
    const callback = vi.fn();
    source.onExit(callback);
    await source.requestUpdate("full-rebuild");
    send({ type: "engine_exit", code: 130, cancelled: true });
    expect(callback).toHaveBeenNthCalledWith(1, "full-rebuild");
    await source.requestUpdate();
    send({ type: "engine_exit", code: 0, cancelled: false });
    expect(callback).toHaveBeenNthCalledWith(2, "auto");
  });

  it("启动十秒后只更新一次，托盘显示和页面切换不再触发", () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      const cleanup = scheduleFinanceStartupUpdate(run);
      cleanup(); // StrictMode 首次模拟卸载。
      scheduleFinanceStartupUpdate(run);
      vi.advanceTimersByTime(9_999);
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(60_000);
      expect(run).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
