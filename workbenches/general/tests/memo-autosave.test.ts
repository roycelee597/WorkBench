import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoAutosave } from "../src/memo-autosave";
import type { Memo, MemoDraft } from "../src/api";

const draft: MemoDraft = { title: "原值", content: "正文", pinned: false, tags: ["标签"] };
function record(id: string, fields: MemoDraft): Memo {
  return {
    id,
    created_at: 1,
    updated_at: 2,
    device_id: "device",
    deleted_at: null,
    deletion_group_id: null,
    purged_at: null,
    ...fields,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const save = vi.fn(async (id: string, fields: MemoDraft) => record(id, fields));
  const saved = vi.fn();
  const status = vi.fn();
  return { save, saved, status, queue: new MemoAutosave({ save, saved, status }) };
}
afterEach(() => {
  vi.useRealTimers();
});
describe("500ms 自动保存与立即提交", () => {
  it("防抖合并连续编辑，在最后输入 500ms 后只保存最新草稿", async () => {
    vi.useFakeTimers();
    const { queue, save, status } = setup();
    queue.schedule("memo", draft);
    await vi.advanceTimersByTimeAsync(300);
    const latest = { ...draft, title: "最新", tags: ["新标签"] };
    queue.schedule("memo", latest);
    latest.tags.push("外部修改");
    await vi.advanceTimersByTimeAsync(499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledExactlyOnceWith("memo", {
      ...draft,
      title: "最新",
      tags: ["新标签"],
    });
    expect(status).toHaveBeenLastCalledWith("saved");
  });
  it("切换或关闭时立即 flush，取消旧定时器并等待全部记录", async () => {
    vi.useFakeTimers();
    const { queue, save } = setup();
    queue.schedule("one", draft);
    queue.schedule("two", { ...draft, title: "第二条" });
    await queue.flush();
    expect(save.mock.calls.map(([id]) => id)).toEqual(["one", "two"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("串行保存，慢写入期间的新输入不被旧结果覆盖，flush 等待新输入落盘", async () => {
    const { queue, save, saved } = setup();
    const first = deferred<Memo>();
    save.mockImplementationOnce(() => first.promise);
    queue.schedule("memo", draft);
    const flushing = queue.flush();
    queue.schedule("memo", { ...draft, title: "新输入" });
    const anotherFlush = queue.flush();
    expect(save).toHaveBeenCalledTimes(1);
    first.resolve(record("memo", draft));
    await Promise.all([flushing, anotherFlush]);
    expect(save.mock.calls[1]?.[1].title).toBe("新输入");
    expect(saved.mock.calls.map((call) => call[1])).toEqual([true, false]);
  });
  it("保存失败保留草稿并拒绝 flush，重试后才报告成功", async () => {
    const { queue, save, status } = setup();
    save.mockRejectedValueOnce(new Error("写入失败"));
    queue.schedule("memo", draft);
    await expect(queue.flush()).rejects.toThrow("写入失败");
    expect(status).toHaveBeenLastCalledWith("error", expect.any(Error));
    await queue.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[1]).toEqual(draft);
    expect(status).toHaveBeenLastCalledWith("saved");
  });
  it("失败旧快照不覆盖保存期间编辑的新草稿，后续记录也不会丢失", async () => {
    const { queue, save } = setup();
    const first = deferred<Memo>();
    save.mockImplementationOnce(() => first.promise);
    queue.schedule("memo", draft);
    queue.schedule("other", draft);
    const flushing = queue.flush();
    queue.schedule("memo", { ...draft, content: "最新正文" });
    first.reject(new Error("失败"));
    await expect(flushing).rejects.toThrow();
    await queue.flush();
    expect(save.mock.calls.slice(1).map(([id, value]) => [id, value.content])).toEqual([
      ["memo", "最新正文"],
      ["other", "正文"],
    ]);
  });
});
