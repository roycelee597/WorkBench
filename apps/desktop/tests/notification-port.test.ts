import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInAppNotificationPort } from "../src/core/scheduler/notification-port";
import { useReminderNotices } from "../src/shell/reminder-notices";
const message = {
  kind: "reminder" as const,
  title: "喝水",
  body: "备注首行",
  occurrenceIds: ["occurrence-1"],
};
beforeEach(() => useReminderNotices.setState({ notices: [] }));
describe("软件内通知", () => {
  it("窗口显示并聚焦完成后，才发布通知条", async () => {
    let release!: () => void;
    const showMain = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const port = createInAppNotificationPort({
      showMain,
      push: useReminderNotices.getState().push,
    });
    const pending = port.show(message);
    expect(showMain).toHaveBeenCalledOnce();
    expect(useReminderNotices.getState().notices).toEqual([]);
    release();
    await pending;
    expect(useReminderNotices.getState().notices).toEqual([expect.objectContaining(message)]);
  });
  it("唤起窗口失败向调度器传播，不误报已显示", async () => {
    const push = vi.fn();
    const port = createInAppNotificationPort({
      showMain: async () => {
        throw new Error("窗口失败");
      },
      push,
    });
    await expect(port.show(message)).rejects.toThrow("窗口失败");
    expect(push).not.toHaveBeenCalled();
  });
  it("同一实例替换避免重复，贪睡再次到期可重新展示，汇总保留全部实例", async () => {
    const store = useReminderNotices.getState();
    store.push(message);
    store.push(message);
    expect(useReminderNotices.getState().notices).toHaveLength(1);
    const key = useReminderNotices.getState().notices[0]!.key;
    store.dismiss(key);
    expect(useReminderNotices.getState().notices).toEqual([]);
    store.push(message);
    store.push({
      kind: "missed",
      title: "你有 2 条错过的提醒",
      body: "查看今天",
      occurrenceIds: ["a", "b"],
    });
    expect(useReminderNotices.getState().notices.map((row) => row.kind)).toEqual([
      "reminder",
      "missed",
    ]);
    expect(useReminderNotices.getState().notices[1]!.occurrenceIds).toEqual(["a", "b"]);
  });
});
