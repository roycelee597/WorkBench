// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiCreateFields,
  AiCreatePreview,
} from "../../../workbenches/general/src/components/AiCreatePreview";
import { EventForm } from "../../../workbenches/general/src/components/EventForm";
import { CalendarPage } from "../../../workbenches/general/src/components/CalendarPage";
import { ReminderFields } from "../../../workbenches/general/src/components/ReminderFields";
import { RemindersPage } from "../../../workbenches/general/src/components/RemindersPage";
import { generalApi } from "../../../workbenches/general/src/api";
import type { AiCreateDraft } from "../../../workbenches/general/src/ai-create-model";
import type { EventDraft } from "../../../workbenches/general/src/calendar-model";
import type { ReminderFormDraft } from "../../../workbenches/general/src/reminder-model";

vi.mock("@fullcalendar/react", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    default: function MockCalendar({
      datesSet,
    }: {
      datesSet: (range: { start: Date; end: Date; view: { title: string; type: string } }) => void;
    }) {
      const initialized = useRef(false);
      useEffect(() => {
        if (initialized.current) return;
        initialized.current = true;
        datesSet({
          start: new Date("2026-11-16T00:00:00Z"),
          end: new Date("2026-11-23T00:00:00Z"),
          view: { title: "测试周", type: "timeGridWeek" },
        });
      }, [datesSet]);
      return <div>测试日历</div>;
    },
  };
});

const event: EventDraft = {
  title: "组会",
  notes: "带上笔记",
  start: "2026-11-18T15:00",
  end: "2026-11-18T16:00",
  allDay: false,
  zone: "Asia/Shanghai",
  color: "#547c69",
  reminder: 30,
  repeat: { preset: "weekly", weekdays: [2], end: "until", until: "2026-12-31", count: "10" },
};
const reminder: ReminderFormDraft = {
  title: "交报告",
  notes: "检查附件",
  timed: true,
  due: "2026-11-18T10:00",
  zone: "Asia/Shanghai",
  priority: 1,
  repeat: { ...event.repeat },
};
const memo: AiCreateDraft = {
  type: "memo",
  form: { title: "备忘录", content: "正文", tags: ["原标签"], pinned: false },
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
function field(text: string, scope: ParentNode = container): Field {
  const label = [...scope.querySelectorAll("label")].find((label) => {
    const ownText = [...label.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join("")
      .trim();
    return ownText === text;
  });
  if (!label?.control) throw new Error(`找不到字段：${text}`);
  return label.control as Field;
}
async function change(input: Field, value: string) {
  await act(async () => {
    const prototype =
      input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
function button(label: string) {
  const element = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!element) throw new Error(`找不到按钮：${label}`);
  return element;
}
async function preview(initial: AiCreateDraft, readOnly = false, errors: string[] = []) {
  let latest = structuredClone(initial);
  const changed = vi.fn();
  function Harness() {
    const [draft, setDraft] = useState(latest);
    return (
      <AiCreatePreview
        draft={draft}
        readOnly={readOnly}
        errors={errors}
        onChange={(value) => {
          latest = value;
          changed(value);
          setDraft(value);
        }}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  return { changed, get: () => latest };
}

describe("AI 新建预览的共享字段", () => {
  it("日程可改标题、时间、全天、备注、颜色、重复和提前提醒，并显示日期星期", async () => {
    const view = await preview({ type: "event", form: event });
    expect(container.textContent).toMatch(/2026.*11.*18.*(?:星期三|周三)/);
    expect(container.textContent).toContain("每周");
    expect(container.textContent).not.toContain("FREQ=");
    await change(field("标题"), "新的组会");
    await change(field("开始"), "2026-11-19T14:00");
    await change(field("结束"), "2026-11-19T16:30");
    await change(field("备注"), "新的备注");
    await click(button("湖蓝"));
    await change(field("提前提醒"), "15");
    await click(button("星期一"));
    await change(field("结束重复"), "count");
    await change(field("总次数"), "6");
    expect(view.get()).toMatchObject({
      type: "event",
      form: {
        title: "新的组会",
        start: "2026-11-19T14:00",
        end: "2026-11-19T16:30",
        notes: "新的备注",
        color: "#4f7db5",
        reminder: 15,
        repeat: { preset: "weekly", weekdays: [0, 2], end: "count", count: "6" },
      },
    });
    await click(field("全天日程"));
    expect(field("开始").type).toBe("date");
    expect(field("结束（含当天）").value).toBe("2026-11-19");
    expect(view.get()).toMatchObject({ form: { allDay: true, start: "2026-11-19" } });
  });

  it("提醒可编辑全部字段，无到期时间时不开放重复设置", async () => {
    const view = await preview({ type: "reminder", form: reminder });
    await change(field("标题"), "新的报告");
    await change(field("备注"), "最终附件");
    await change(field("到期时间"), "2026-11-20T17:00");
    await change(field("优先级"), "3");
    await change(field("重复"), "daily");
    await change(field("结束重复"), "until");
    await change(field("截止日期"), "2026-12-20");
    expect(view.get()).toMatchObject({
      type: "reminder",
      form: {
        title: "新的报告",
        notes: "最终附件",
        due: "2026-11-20T17:00",
        priority: 3,
        repeat: { preset: "daily", end: "until", until: "2026-12-20" },
      },
    });
    await click(field("设置到期时间"));
    expect(field("重复").value).toBe("none");
    expect(field("重复").matches(":disabled")).toBe(true);
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(view.get()).toMatchObject({ form: { timed: false } });
  });

  it("备忘录正文、标题、标签和错误始终是纯文本，允许编辑和置顶", async () => {
    const content = "<script>window.bad = true</script> **粗体** [链接](https://example.com)";
    const view = await preview(
      { ...memo, form: { ...memo.form, title: "<img src=x>", content } },
      false,
      ["<img src=x onerror=bad()>"],
    );
    expect(field("正文").value).toBe(content);
    expect(field("标题").value).toBe("<img src=x>");
    expect(container.querySelector("script,img,a,strong")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("<img src=x");
    await change(field("标题"), "整理后的备忘录");
    await change(field("正文"), "新的正文");
    await click(field("置顶"));
    const tag = container.querySelector<HTMLInputElement>('input[aria-label="添加标签"]')!;
    await change(tag, " 新标签 ");
    await act(async () =>
      tag.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    await click(button("移除标签 原标签"));
    expect(view.get()).toEqual({
      type: "memo",
      form: { title: "整理后的备忘录", content: "新的正文", tags: ["新标签"], pinned: true },
    });
  });

  it.each<AiCreateDraft>([
    { type: "event", form: event },
    { type: "reminder", form: reminder },
    memo,
  ])("$type 只读预览禁用所有控件，不触发编辑回调", async (draft) => {
    const view = await preview(draft, true);
    for (const control of container.querySelectorAll("input,textarea,select,button"))
      expect(control.matches(":disabled")).toBe(true);
    await change(field("标题"), "不得改动");
    const firstButton = container.querySelector("button");
    if (firstButton) await click(firstButton);
    expect(view.changed).not.toHaveBeenCalled();
  });

  it("多张卡片没有嵌套表单或重复 id，每个字段 label 对应自己的控件且不抢输入焦点", async () => {
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();
    try {
      await act(async () =>
        root.render(
          <>
            <AiCreateFields draft={{ type: "event", form: event }} onChange={() => undefined} />
            <AiCreateFields draft={{ type: "event", form: event }} onChange={() => undefined} />
            <AiCreateFields
              draft={{ type: "reminder", form: reminder }}
              onChange={() => undefined}
            />
            <AiCreateFields draft={memo} onChange={() => undefined} />
          </>,
        ),
      );
      const ids = [...container.querySelectorAll("[id]")].map((node) => node.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(container.querySelector("form")).toBeNull();
      for (const label of container.querySelectorAll("label")) {
        expect(label.control).not.toBeNull();
        expect(label.contains(label.control)).toBe(true);
      }
      expect(document.activeElement).toBe(composer);
    } finally {
      composer.remove();
    }
  });
});

describe("原日程与提醒表单的复用回归", () => {
  it("原日程表单仍使用原 id 和默认聚焦，保留提交行为", async () => {
    const onSubmit = vi.fn();
    await act(async () =>
      root.render(
        <EventForm draft={event} onChange={() => undefined} onSubmit={onSubmit} busy={false} />,
      ),
    );
    expect(container.querySelector("form")?.id).toBe("event-form");
    expect(document.activeElement).toBe(field("标题"));
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("允许独立 formId 和关闭自动聚焦，保存中所有日程字段禁用并阻止提交", async () => {
    const submit = vi.fn();
    await act(async () =>
      root.render(
        <EventForm
          draft={event}
          onChange={() => undefined}
          onSubmit={submit}
          busy
          formId="manual-ai-event"
          autoFocus={false}
        />,
      ),
    );
    expect(container.querySelector("form")?.id).toBe("manual-ai-event");
    expect(document.activeElement).not.toBe(field("标题"));
    for (const control of container.querySelectorAll("input,textarea,select,button"))
      expect(control.matches(":disabled")).toBe(true);
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("日程生成的提醒仍禁止修改内容和时间，原有优先级可编辑", async () => {
    await act(async () =>
      root.render(
        <ReminderFields draft={reminder} onChange={() => undefined} generated autoFocus />,
      ),
    );
    expect((field("标题") as HTMLInputElement).readOnly).toBe(true);
    expect((field("备注") as HTMLTextAreaElement).readOnly).toBe(true);
    expect((field("到期时间") as HTMLInputElement).readOnly).toBe(true);
    expect(field("设置到期时间").matches(":disabled")).toBe(true);
    expect(field("重复").matches(":disabled")).toBe(true);
    expect(field("优先级").matches(":disabled")).toBe(false);
  });

  it("原提醒页面仍通过保存按钮提交共享字段，普通待办不带时间或重复", async () => {
    vi.spyOn(generalApi, "listReminders").mockResolvedValue([]);
    vi.spyOn(generalApi, "subscribeChanges").mockResolvedValue(() => undefined);
    const save = vi
      .spyOn(generalApi, "createReminder")
      .mockRejectedValue(new Error("测试保存中断"));
    await act(async () => root.render(<RemindersPage createRequested />));
    await change(field("标题", document), "手动待办");
    await change(field("备注", document), "保留备注");
    await change(field("优先级", document), "2");
    const saveButton = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "保存",
    )!;
    expect(saveButton.getAttribute("form")).toBe("reminder-form");
    await click(saveButton);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "手动待办",
        notes: "保留备注",
        due_at: null,
        rrule: null,
        priority: 2,
      }),
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("测试保存中断");
  });

  it("提醒编辑器随工作台隐藏时关闭 Portal，返回后保留未保存草稿且不写入", async () => {
    vi.spyOn(generalApi, "listReminders").mockResolvedValue([]);
    vi.spyOn(generalApi, "subscribeChanges").mockResolvedValue(() => undefined);
    const save = vi.spyOn(generalApi, "createReminder");
    await act(async () => root.render(<RemindersPage createRequested />));
    await change(field("标题", document), "切换时保留的提醒");
    await change(field("备注", document), "这还是未保存内容");
    await click(field("设置到期时间", document));
    await change(field("到期时间", document), "2026-11-20T17:30");
    await change(field("优先级", document), "3");
    await change(field("重复", document), "weekly");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => root.render(<RemindersPage createRequested visible={false} />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.getElementById("reminder-form")).toBeNull();
    await act(async () => root.render(<RemindersPage createRequested visible />));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(field("标题", document).value).toBe("切换时保留的提醒");
    expect(field("备注", document).value).toBe("这还是未保存内容");
    expect(field("到期时间", document).value).toBe("2026-11-20T17:30");
    expect(field("优先级", document).value).toBe("3");
    expect(field("重复", document).value).toBe("weekly");
    expect(save).not.toHaveBeenCalled();
  });

  it("日程编辑器随工作台隐藏时关闭 Portal，返回后保留未保存草稿且不写入", async () => {
    vi.spyOn(generalApi, "loadCalendar").mockResolvedValue({
      events: [],
      occurrences: [],
      defaultReminder: null,
    });
    vi.spyOn(generalApi, "subscribeChanges").mockResolvedValue(() => undefined);
    const save = vi.spyOn(generalApi, "createEvent");
    await act(async () => root.render(<CalendarPage />));
    const create = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "新建日程",
    )!;
    expect(create.disabled).toBe(false);
    await click(create);
    await change(field("标题", document), "切换时保留的日程");
    await change(field("备注", document), "尚未保存的安排");
    await change(field("开始", document), "2026-11-20T09:00");
    await change(field("结束", document), "2026-11-20T10:00");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => root.render(<CalendarPage visible={false} />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.getElementById("event-form")).toBeNull();
    await act(async () => root.render(<CalendarPage visible />));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(field("标题", document).value).toBe("切换时保留的日程");
    expect(field("备注", document).value).toBe("尚未保存的安排");
    expect(field("开始", document).value).toBe("2026-11-20T09:00");
    expect(field("结束", document).value).toBe("2026-11-20T10:00");
    expect(save).not.toHaveBeenCalled();
  });
});
