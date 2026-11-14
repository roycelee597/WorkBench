import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AiRegistry, aiRegistry } from "../src/core/ai/registry";
import {
  DATA_NOTICE,
  type AiActionDefinition,
  type AiActionGroup,
  type AiTarget,
} from "../src/core/ai/action-types";
import { MemoryRefTable, REF_TTL_MS } from "../src/core/ai/ref-table";
import { parseLocalTime, formatLocalTime } from "../src/core/ai/local-time";
import { buildSystemPrompt } from "../src/core/ai/prompt";
import { llmRequestSchema } from "../src/core/ai/llm-client";

const workbenchId = "com.royce.workbench.test";
const parameters = { type: "object", properties: {}, additionalProperties: false } as const;
const Preview = () => null;
function read(name = "calendar_list_events"): AiActionDefinition<Record<string, never>> {
  return {
    name,
    workbenchId,
    kind: "read",
    description: "读取测试数据",
    parameters: { ...parameters },
    args: z.object({}).strict(),
    prepare: vi.fn(async () => ({
      type: "data" as const,
      payload: {
        type: "workbench_data" as const,
        notice: DATA_NOTICE,
        range: { from: "2026-11-15", to: "2026-11-16" },
        total: 0,
        truncated: false,
        items: [],
      },
      items: [],
    })),
  };
}
function write(name = "calendar_create_event"): AiActionDefinition<Record<string, never>> {
  return {
    ...read(name),
    kind: "write",
    Preview,
    validate: () => [],
    execute: vi.fn(async () => ({ message: "已保存" })),
  };
}
function group(actions: AiActionGroup["actions"]): AiActionGroup {
  return { workbenchId, label: "测试日程", actions };
}

describe("AI 操作登记表", () => {
  it("正式单例为空；登记只生成工具说明，不执行任何操作", () => {
    expect(aiRegistry.tools()).toEqual([]);
    const registry = new AiRegistry();
    const action = read();
    registry.register(group([action, write()]));
    expect(registry.get(action.name)?.name).toBe(action.name);
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.groups()).toHaveLength(1);
    expect(registry.tools()).toEqual([
      {
        type: "function",
        function: { name: action.name, description: action.description, parameters },
      },
      {
        type: "function",
        function: { name: "calendar_create_event", description: action.description, parameters },
      },
    ]);
    expect(llmRequestSchema.shape.tools.safeParse(registry.tools()).success).toBe(true);
    expect(registry.tools({ allowRead: false }).map((tool) => tool.function.name)).toEqual([
      "calendar_create_event",
    ]);
    expect(action.prepare).not.toHaveBeenCalled();
  });

  it("同组和跨组的重名均拒绝，整批登记失败不保留部分操作", () => {
    const registry = new AiRegistry();
    expect(() => registry.register(group([read(), read()]))).toThrow("重复");
    expect(registry.tools()).toEqual([]);
    registry.register(group([read()]));
    expect(() => registry.register(group([write(), read()]))).toThrow("重复");
    expect(registry.tools()).toHaveLength(1);
    expect(registry.get("calendar_create_event")).toBeUndefined();
  });

  it.each(["execute", "Preview", "validate"] as const)("写入类缺少 %s 时拒绝", (field) => {
    const action = write();
    delete action[field];
    expect(() => new AiRegistry().register(group([action]))).toThrow("必须提供");
  });

  it("读取类不能偷偷带 execute，名称和根参数必须符合工具协议", () => {
    const action = read();
    action.execute = vi.fn(async () => ({ message: "禁止" }));
    expect(() => new AiRegistry().register(group([action]))).toThrow("不能提供");
    for (const name of ["bad", "Calendar_read", "calendar_read2", "calendar-read"]) {
      expect(() => new AiRegistry().register(group([read(name)]))).toThrow("名称格式");
    }
    const badRoot = { ...read(), parameters: { ...parameters, additionalProperties: true } };
    // 模拟来自未定型接入代码的非法定义，运行时仍必须拒绝。
    expect(() =>
      new AiRegistry().register(group([badRoot as unknown as ReturnType<typeof read>])),
    ).toThrow();
    expect(() => new AiRegistry().register(group([{ ...read(), workbenchId: "another" }]))).toThrow(
      "不一致",
    );
    expect(() =>
      new AiRegistry().register(group([{ ...read(), description: "文".repeat(301) }])),
    ).toThrow("1–300");
  });

  it("工具参数保持独立快照，调用方不能修改内部登记", () => {
    const registry = new AiRegistry();
    const action = read();
    action.parameters.properties = { title: { type: "string" } };
    registry.register(group([action]));
    action.parameters.properties["title"] = { type: "number" };
    const fromGet = registry.get(action.name)!;
    fromGet.parameters.properties["title"] = { type: "boolean" };
    registry.tools()[0]!.function.parameters.properties["title"] = {};
    registry.groups()[0]!.actions[0]!.parameters.properties["title"] = {};
    expect(registry.tools()[0]!.function.parameters.properties["title"]).toEqual({
      type: "string",
    });
  });
});

describe("AI 短引用表", () => {
  it("发出短引用、保留本地快照并按种类解析；不存在和类型不符拒绝", () => {
    const table = new MemoryRefTable({ now: () => 1_000 });
    const target: AiTarget = { kind: "event", eventId: "private-real-event-id", originalStart: 99 };
    const ref = table.issue(target, { updatedAt: 900 });
    expect(ref).toBe("e1");
    expect(ref).not.toContain(target.eventId);
    target.eventId = "changed";
    expect(table.resolve(ref, "reminder")).toBeNull();
    const entry = table.resolve(ref, "event")!;
    expect(entry).toEqual({
      ref: "e1",
      target: { kind: "event", eventId: "private-real-event-id", originalStart: 99 },
      updatedAt: 900,
      issuedAt: 1_000,
    });
    entry.target = { kind: "memo", memoId: "changed" };
    expect(table.resolve(ref, "event")?.target.kind).toBe("event");
    expect(table.resolve("made-up", "event")).toBeNull();
    expect(
      table.issue({ kind: "reminder", reminderId: "r", occurrenceId: null }, { updatedAt: 900 }),
    ).toBe("r1");
    expect(table.issue({ kind: "memo", memoId: "m" }, { updatedAt: 900 })).toBe("m1");
  });

  it("30 分钟到期，清空和回拨使旧引用失效，编号不复用", () => {
    let now = 0;
    const table = new MemoryRefTable({ now: () => now });
    const target: AiTarget = { kind: "event", eventId: "e", originalStart: null };
    const first = table.issue(target, { updatedAt: 0 });
    now = REF_TTL_MS - 1;
    expect(table.resolve(first, "event")).not.toBeNull();
    now++;
    expect(table.resolve(first, "event")).toBeNull();
    const second = table.issue(target, { updatedAt: now });
    table.clear();
    expect(table.resolve(second, "event")).toBeNull();
    const third = table.issue(target, { updatedAt: now });
    expect([first, second, third]).toEqual(["e1", "e2", "e3"]);
    now--;
    expect(table.resolve(third, "event")).toBeNull();
  });

  it("没有解析也会清理过期引用，时间元数据必须有效", () => {
    let now = 0;
    const table = new MemoryRefTable({ now: () => now });
    const target: AiTarget = { kind: "memo", memoId: "m" };
    const stale = table.issue(target, { updatedAt: 0 });
    now += REF_TTL_MS;
    table.issue(target, { updatedAt: 1 });
    expect(table.resolve(stale, "memo")).toBeNull();
    expect(() => table.issue(target, { updatedAt: NaN })).toThrow("时间");
  });
});

describe("AI 本地日期时间", () => {
  it("按指定时区转换分钟和全天日期，不依赖系统时区", () => {
    const stamp = parseLocalTime("2026-11-15T08:30", "Asia/Shanghai");
    expect(stamp).toBe(Date.UTC(2026, 10, 15, 0, 30));
    expect(formatLocalTime(stamp, "Asia/Shanghai")).toBe("2026-11-15T08:30");
    expect(formatLocalTime(stamp, "America/New_York")).toBe("2026-11-14T19:30");
    expect(parseLocalTime("2026-11-15", "Asia/Shanghai")).toBe(Date.UTC(2026, 10, 14, 16));
    expect(formatLocalTime(stamp, "Asia/Shanghai", true)).toBe("2026-11-15");
  });

  it.each([
    "2026-02-30",
    "2026-13-01",
    "2026-01-01T24:00",
    "2026-01-01T12:60",
    "2026-1-1",
    "2026-11-15T08:30Z",
    "2026-11-15T08:30:00",
  ])("拒绝非法日期和非约定格式 %s", (value) => {
    expect(() => parseLocalTime(value, "Asia/Shanghai")).toThrow();
  });

  it("夏令时跳过的时刻报错，重复时刻选择较早一次", () => {
    expect(() => parseLocalTime("2026-03-08T02:30", "America/New_York")).toThrow("夏令时");
    expect(parseLocalTime("2026-11-01T01:30", "America/New_York")).toBe(
      Date.UTC(2026, 10, 1, 5, 30),
    );
    expect(() => parseLocalTime("2026-11-15", "invalid")).toThrow("时区");
    expect(() => formatLocalTime(NaN, "Asia/Shanghai")).toThrow("时间");
  });
});

describe("AI 系统提示词", () => {
  it("固定时间快照包含安全规则、日期表和无工具限制", () => {
    const prompt = buildSystemPrompt({
      now: Date.UTC(2026, 10, 14, 11, 30),
      timezone: "Asia/Shanghai",
      tools: [],
    });
    expect(prompt).toMatchSnapshot();
    expect(prompt).toContain(DATA_NOTICE);
    expect(prompt).toContain("没有可用函数");
  });

  it.each([
    ["2026-11-25T09:00", "2026-12-08 星期二"],
    ["2026-12-25T09:00", "2027-01-07 星期四"],
  ])("14 天日期表正确跨月跨年：%s", (local, last) => {
    const registry = new AiRegistry();
    registry.register(group([read()]));
    const prompt = buildSystemPrompt({
      now: parseLocalTime(local, "Asia/Shanghai"),
      timezone: "Asia/Shanghai",
      tools: registry.tools(),
    });
    const dates = prompt.split("\n").filter((line) => /^\d{4}-\d{2}-\d{2} 星期/.test(line));
    expect(dates).toHaveLength(14);
    expect(dates.at(-1)).toBe(last);
    expect(prompt).toContain("下一个自然周（周一开始）");
    expect(prompt).toContain("当前可用函数：calendar_list_events");
  });
});
