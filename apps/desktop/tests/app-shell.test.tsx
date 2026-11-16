// @vitest-environment jsdom
import { act, type ButtonHTMLAttributes, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspace } from "@workbench/general";
import type { NotificationAction } from "../src/core/scheduler/notification-port";
import { FINANCE_WORKBENCH } from "../src/core/finance/finance-target";
import { AppShell } from "../src/shell/AppShell";
import type { AiHostServices } from "../../../workbenches/ai/src/host-services";
import {
  parseAiCreateDraft,
  type AiCreateDraft,
} from "../../../workbenches/general/src/ai-create-model";

const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  flush: vi.fn(),
  navigate: vi.fn(),
  newReminder: vi.fn(),
  openReminder: vi.fn(),
  openMissed: vi.fn(),
  openAiTarget: vi.fn(),
  openCreateDraft: vi.fn(),
  resolve: vi.fn(),
  complete: vi.fn(),
  snooze: vi.fn(),
  financeOpen: vi.fn(),
  financeRuntime: vi.fn(),
  scheduler: vi.fn(),
  schedulerStop: vi.fn(),
  quickStart: vi.fn(),
  aiStart: vi.fn(),
  configureGeneral: vi.fn(),
  configureAi: vi.fn(),
  shellListener: null as null | (() => void),
  aiOpening: null as null | (() => Promise<void>),
  noticeAction: null as null | ((action: NotificationAction) => Promise<void>),
  aiStatus: {
    configured: "Ctrl+Alt+Space",
    active: "Ctrl+Alt+Space",
    error: null as string | null,
  },
  aiSubscriber: null as null | (() => void),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke, isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mock.listen }));
vi.mock("@tauri-apps/plugin-autostart", () => ({
  enable: vi.fn(),
  disable: vi.fn(),
  isEnabled: vi.fn(async () => false),
}));
vi.mock("../src/core/scheduler/runtime", () => ({ initializeReminderRuntime: mock.scheduler }));
vi.mock("../src/shell/quick-bridge", () => ({ initializeQuickHost: vi.fn(async () => undefined) }));
vi.mock("../src/shell/shortcut-runtime", () => ({
  shortcutController: { start: mock.quickStart, configure: vi.fn(), getStatus: vi.fn() },
  aiShortcutController: { start: mock.aiStart, configure: vi.fn(), getStatus: () => mock.aiStatus },
  configureAiShortcutOpening: (open: () => Promise<void>) => {
    mock.aiOpening = open;
    return () => {
      mock.aiOpening = null;
    };
  },
  getAiShortcutStatus: () => mock.aiStatus,
  subscribeAiShortcutStatus: (subscriber: () => void) => {
    mock.aiSubscriber = subscriber;
    return () => {
      mock.aiSubscriber = null;
    };
  },
}));
vi.mock("@workbench/general", async () => {
  const { create } = await import("zustand");
  const useWorkspace = create(() => ({
    ready: true,
    busy: false,
    page: "today",
    error: null as string | null,
    shortcutError: null,
    desktopError: null,
    autostartOffer: false,
    createDraft: null as AiCreateDraft | null,
    deleted: [],
    deletedEvents: [],
    deletedReminders: [],
    navigate: mock.navigate,
    newReminder: mock.newReminder,
    openReminder: mock.openReminder,
    openMissed: mock.openMissed,
    openCreateDraft: mock.openCreateDraft,
  }));
  return {
    workspace: { useWorkspace, flush: mock.flush },
    GeneralWorkbench: ({
      settingsExtra,
      active,
    }: {
      settingsExtra: React.ReactNode;
      active: boolean;
    }) => (
      <section data-testid="general" data-active={active}>
        综合内容{settingsExtra}
      </section>
    ),
    generalApi: {
      reminderTarget: mock.resolve,
      completeReminder: mock.complete,
      snoozeReminder: mock.snooze,
      setAutostart: vi.fn(),
    },
    configureHostServices: mock.configureGeneral,
    onAutostartOffer: () => () => undefined,
    generalAiActions: { workbenchId: "test.shell.general", label: "测试综合", actions: [] },
    openAiTarget: mock.openAiTarget,
  };
});
vi.mock("@workbench/finance", () => ({
  FinanceSettings: () => <span>金融设置</span>,
  FinanceBackfillDialog: () => null,
  financeApi: { startRuntime: mock.financeRuntime, openReminder: mock.financeOpen },
}));
vi.mock("@workbench/finance/page", () => ({
  FinanceWorkbench: ({ openSettings }: { openSettings: () => void }) => (
    <section data-testid="finance">
      金融内容<button onClick={openSettings}>金融设置入口</button>
    </section>
  ),
}));
vi.mock("@workbench/ai", () => ({
  AiSettings: () => <h3 id="ai-settings-heading">AI 设置</h3>,
  configureAiHostServices: mock.configureAi,
}));
vi.mock("@workbench/ai/page", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    AiWorkbench: ({
      focusVersion,
      openSettings,
      manualCreate,
    }: {
      focusVersion: number;
      openSettings: () => void;
      manualCreate: () => void;
    }) => {
      const input = useRef<HTMLTextAreaElement>(null);
      useEffect(() => {
        input.current?.focus();
      }, [focusVersion]);
      return (
        <section data-testid="ai">
          <textarea ref={input} aria-label="AI 输入" data-focus-version={focusVersion} />
          <button onClick={openSettings}>AI 设置入口</button>
          <button onClick={manualCreate}>手动新建</button>
        </section>
      );
    },
  };
});
vi.mock("../src/shell/ReminderNotices", () => ({
  ReminderNotices: ({ onAction }: { onAction: (action: NotificationAction) => Promise<void> }) => {
    mock.noticeAction = onAction;
    return null;
  },
}));
vi.mock("@workbench/ui", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  Button: ({
    size,
    variant,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    size?: string;
    variant?: string;
  }) => {
    void size;
    void variant;
    return <button {...props} />;
  },
  Dialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) => (open ? children : null),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  mock.aiStatus = { configured: "Ctrl+Alt+Space", active: "Ctrl+Alt+Space", error: null };
  workspace.useWorkspace.setState({
    ready: true,
    busy: false,
    page: "today",
    error: null,
    shortcutError: null,
    desktopError: null,
    autostartOffer: false,
    createDraft: null,
  });
  mock.flush.mockReset().mockResolvedValue(undefined);
  mock.navigate.mockReset().mockImplementation(async (page: "today" | "settings" | "trash") => {
    await mock.flush();
    workspace.useWorkspace.setState({ page, error: null });
  });
  mock.newReminder.mockReset().mockImplementation(async () => {
    await mock.flush();
    workspace.useWorkspace.setState({ page: "reminders", error: null });
  });
  mock.openReminder.mockReset().mockImplementation(async () => {
    await mock.flush();
    workspace.useWorkspace.setState({ page: "reminders", error: null });
  });
  mock.openMissed.mockReset().mockImplementation(async () => {
    await mock.flush();
    workspace.useWorkspace.setState({ page: "reminders", error: null });
  });
  mock.openAiTarget.mockReset().mockImplementation(async () => {
    workspace.useWorkspace.setState({ page: "memos", error: null });
  });
  mock.openCreateDraft.mockReset().mockImplementation(async (_name: string, draft: unknown) => {
    workspace.useWorkspace.setState({
      createDraft: parseAiCreateDraft(draft),
      page: "memos",
      error: null,
    });
  });
  mock.quickStart.mockResolvedValue(undefined);
  mock.aiStart.mockResolvedValue(undefined);
  mock.financeRuntime.mockReturnValue(() => undefined);
  mock.financeOpen.mockResolvedValue(undefined);
  mock.scheduler.mockResolvedValue({ stop: mock.schedulerStop });
  mock.invoke
    .mockReset()
    .mockImplementation(async (command: string) =>
      command === "take_shell_requests" ? [] : undefined,
    );
  mock.listen.mockImplementation(async (_event: string, listener: () => void) => {
    mock.shellListener = listener;
    return () => {
      mock.shellListener = null;
    };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<AppShell />);
  });
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function button(text: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent === text)!;
}

function aiHost() {
  return mock.configureAi.mock.calls[0]![0] as Required<AiHostServices>;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const memoDraft: AiCreateDraft = {
  type: "memo",
  form: { title: "转到表单", content: "尚未保存", pinned: false, tags: [] },
};
async function click(text: string) {
  await act(async () => {
    button(text).click();
  });
}
function selected() {
  return container.querySelector(".sidebar-link.selected")?.textContent;
}
async function tray(requests: string[]) {
  mock.invoke.mockImplementation(async (command: string) =>
    command === "take_shell_requests" ? requests : undefined,
  );
  await act(async () => {
    mock.shellListener!();
  });
}

describe("三个内置工作台的 Shell", () => {
  it("侧栏顺序稳定，AI 和金融按需显示，综合内容一直保留挂载", async () => {
    expect([...container.querySelectorAll("nav button")].map((item) => item.textContent)).toEqual([
      "综合工作台",
      "金融指标",
      "AI 助手",
    ]);
    const general = container.querySelector('[data-testid="general"]');
    await click("AI 助手");
    expect(selected()).toBe("AI 助手");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("AI 输入");
    await click("金融指标");
    expect(selected()).toBe("金融指标");
    expect(container.querySelector('[data-testid="finance"]')).not.toBeNull();
    await click("综合工作台");
    expect(selected()).toBe("综合工作台");
    expect(container.querySelector('[data-testid="general"]')).toBe(general);
    expect(container.querySelector('[data-testid="ai"]')).toBeNull();
    expect(mock.configureAi).toHaveBeenCalledOnce();
  });
  it("AI 快捷键先显示主窗，等待综合保存后才切换，并能重复聚焦", async () => {
    await click("金融指标");
    mock.invoke.mockClear();
    mock.flush.mockClear();
    await act(async () => {
      workspace.useWorkspace.setState({ busy: true });
    });
    let opened!: Promise<void>;
    await act(async () => {
      opened = mock.aiOpening!();
    });
    expect(mock.invoke).toHaveBeenCalledWith("show_main");
    expect(mock.flush).not.toHaveBeenCalled();
    expect(selected()).toBe("金融指标");
    await act(async () => {
      workspace.useWorkspace.setState({ busy: false });
      await opened;
    });
    expect(selected()).toBe("AI 助手");
    const first = Number(container.querySelector("textarea")!.dataset.focusVersion);
    await act(async () => {
      button("AI 设置入口").focus();
      await mock.aiOpening!();
    });
    expect(Number(container.querySelector("textarea")!.dataset.focusVersion)).toBe(first + 1);
    expect(document.activeElement).toBe(container.querySelector("textarea"));
  });
  it("保存失败时侧栏和快捷键均保留当前工作台，错误会交给快捷键调用方", async () => {
    mock.flush.mockRejectedValue(new Error("草稿尚未保存"));
    await click("AI 助手");
    expect(selected()).toBe("综合工作台");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () => {
      await expect(mock.aiOpening!()).rejects.toThrow("草稿尚未保存");
    });
    expect(selected()).toBe("综合工作台");
    expect(container.textContent).toContain("草稿尚未保存");
    error.mockRestore();
  });
  it("AI 设置和手动新建均回到综合，设置会定位 AI 分区", async () => {
    await click("AI 助手");
    await click("AI 设置入口");
    expect(selected()).toBe("设置");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    await click("AI 助手");
    await click("手动新建");
    expect(mock.newReminder).toHaveBeenCalledOnce();
    expect(selected()).toBe("综合工作台");
  });
  it("AI 的手动新建等待综合操作完成，不会因 busy 被工作台忽略", async () => {
    await click("AI 助手");
    await act(async () => {
      workspace.useWorkspace.setState({ busy: true });
    });
    await click("手动新建");
    expect(mock.newReminder).not.toHaveBeenCalled();
    expect(selected()).toBe("AI 助手");
    await act(async () => {
      workspace.useWorkspace.setState({ busy: false });
    });
    expect(mock.newReminder).toHaveBeenCalledOnce();
    expect(selected()).toBe("综合工作台");
  });
  it("两个快捷键错误条各自显示，AI 错误入口定位自己的设置", async () => {
    await act(async () => {
      workspace.useWorkspace.setState({ shortcutError: "快速新建被占用" });
      mock.aiStatus = { ...mock.aiStatus, error: "与快速新建快捷键冲突" };
      mock.aiSubscriber!();
    });
    expect(button("快捷键设置")).toBeDefined();
    expect(button("AI 快捷键设置")).toBeDefined();
    await click("AI 快捷键设置");
    expect(selected()).toBe("设置");
  });
});

describe("已有通知和托盘跳转回归", () => {
  it("AI 中收到综合提醒或漏报会回综合，金融提醒仍打开金融来源", async () => {
    await click("AI 助手");
    mock.resolve.mockResolvedValue({
      reminderId: "general-reminder",
      occurrenceId: "o1",
      sourceWorkbench: null,
    });
    await act(async () => {
      await mock.noticeAction!({ kind: "open", occurrenceId: "o1" });
    });
    expect(mock.openReminder).toHaveBeenCalledOnce();
    expect(selected()).toBe("综合工作台");
    await click("AI 助手");
    mock.resolve.mockResolvedValue({
      reminderId: "finance-reminder",
      occurrenceId: "o2",
      sourceWorkbench: FINANCE_WORKBENCH,
    });
    await act(async () => {
      await mock.noticeAction!({ kind: "open", occurrenceId: "o2" });
    });
    expect(mock.financeOpen).toHaveBeenCalledWith("finance-reminder");
    expect(selected()).toBe("金融指标");
    await act(async () => {
      await mock.noticeAction!({ kind: "missed", count: 3 });
    });
    expect(mock.openMissed).toHaveBeenCalledWith(3);
    expect(selected()).toBe("综合工作台");
  });
  it("通知目标打开失败时保留 AI 页，完成与稍后提醒不切页", async () => {
    await click("AI 助手");
    mock.resolve.mockResolvedValue({ reminderId: "r", occurrenceId: "o", sourceWorkbench: null });
    mock.openReminder.mockResolvedValueOnce(undefined);
    await act(async () => {
      workspace.useWorkspace.setState({ error: "提醒已删除" });
    });
    await act(async () => {
      await expect(mock.noticeAction!({ kind: "open", occurrenceId: "o" })).rejects.toThrow(
        "提醒已删除",
      );
    });
    expect(selected()).toBe("AI 助手");
    await act(async () => {
      await mock.noticeAction!({ kind: "complete", occurrenceId: "o" });
    });
    await act(async () => {
      await mock.noticeAction!({ kind: "snooze", occurrenceId: "o" });
    });
    expect(mock.complete).toHaveBeenCalledOnce();
    expect(mock.snooze).toHaveBeenCalledOnce();
    expect(selected()).toBe("AI 助手");
  });
  it("托盘新建回综合；隐藏和退出先保存，退出停止调度器", async () => {
    await click("AI 助手");
    await tray(["new-reminder"]);
    expect(mock.newReminder).toHaveBeenCalledOnce();
    expect(selected()).toBe("综合工作台");
    mock.flush.mockClear();
    await tray(["hide", "exit"]);
    expect(mock.flush).toHaveBeenCalledTimes(2);
    expect(mock.invoke).toHaveBeenCalledWith("hide_main");
    expect(mock.invoke).toHaveBeenCalledWith("exit_app");
    expect(mock.schedulerStop).toHaveBeenCalledOnce();
  });
  it("托盘保存失败时不隐藏或退出，也不会把 AI 切回综合", async () => {
    await click("AI 助手");
    mock.flush.mockRejectedValue(new Error("保存失败"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await tray(["new-reminder", "hide", "exit"]);
    expect(selected()).toBe("AI 助手");
    expect(mock.invoke).not.toHaveBeenCalledWith("hide_main");
    expect(mock.invoke).not.toHaveBeenCalledWith("exit_app");
    expect(mock.schedulerStop).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("AI 保存结果与手动表单的 Shell 接线", () => {
  it("查看先保存综合草稿，定位成功才切综合，general active 跟随工作台", async () => {
    await click("AI 助手");
    expect(container.querySelector('[data-testid="general"]')?.getAttribute("data-active")).toBe(
      "false",
    );
    const saving = deferred();
    mock.flush.mockClear().mockReturnValueOnce(saving.promise);
    const target = { kind: "memo" as const, memoId: "new-memo" };
    let opening!: Promise<void>;
    await act(async () => {
      opening = aiHost().openTarget(target);
    });
    expect(mock.flush).toHaveBeenCalledOnce();
    expect(mock.openAiTarget).not.toHaveBeenCalled();
    expect(selected()).toBe("AI 助手");
    await act(async () => {
      saving.resolve();
      await opening;
    });
    expect(mock.openAiTarget).toHaveBeenCalledExactlyOnceWith(target);
    expect(selected()).toBe("综合工作台");
    expect(container.querySelector('[data-testid="general"]')?.getAttribute("data-active")).toBe(
      "true",
    );
  });
  it("转表单先保存再交付草稿，等待期间不会提前切页", async () => {
    await click("AI 助手");
    const saving = deferred();
    mock.flush.mockClear().mockReturnValueOnce(saving.promise);
    let opening!: Promise<void>;
    await act(async () => {
      opening = aiHost().openCreateForm("memos_create", memoDraft);
    });
    expect(mock.flush).toHaveBeenCalledOnce();
    expect(mock.openCreateDraft).not.toHaveBeenCalled();
    expect(selected()).toBe("AI 助手");
    await act(async () => {
      saving.resolve();
      await opening;
    });
    expect(mock.openCreateDraft).toHaveBeenCalledExactlyOnceWith("memos_create", memoDraft);
    expect(workspace.useWorkspace.getState().createDraft).toEqual(memoDraft);
    expect(selected()).toBe("综合工作台");
  });
  it("任一 host 导航在保存失败时均保持 AI，且不交付目标或草稿", async () => {
    await click("AI 助手");
    mock.flush.mockRejectedValue(new Error("综合草稿仍未保存"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () => {
      await expect(aiHost().openTarget({ kind: "memo", memoId: "memo" })).rejects.toThrow(
        "综合草稿仍未保存",
      );
      await expect(aiHost().openCreateForm("memos_create", memoDraft)).rejects.toThrow(
        "综合草稿仍未保存",
      );
    });
    expect(selected()).toBe("AI 助手");
    expect(mock.openAiTarget).not.toHaveBeenCalled();
    expect(mock.openCreateDraft).not.toHaveBeenCalled();
    expect(workspace.useWorkspace.getState().createDraft).toBeNull();
  });
  it("目标已删除或表单校验失败时保持 AI，错误返回给卡片", async () => {
    await click("AI 助手");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mock.openAiTarget.mockRejectedValueOnce(new Error("备忘录已删除"));
    await act(async () => {
      await expect(aiHost().openTarget({ kind: "memo", memoId: "deleted" })).rejects.toThrow(
        "备忘录已删除",
      );
    });
    expect(selected()).toBe("AI 助手");
    mock.openCreateDraft.mockImplementationOnce(async () => {
      workspace.useWorkspace.setState({ error: "草稿类型与操作不一致" });
    });
    await act(async () => {
      await expect(aiHost().openCreateForm("reminders_create", memoDraft)).rejects.toThrow(
        "草稿类型与操作不一致",
      );
    });
    expect(selected()).toBe("AI 助手");
  });
  it("已有手动草稿时拒绝覆盖，原草稿在切回 AI 后仍保留", async () => {
    const existing = structuredClone(memoDraft);
    existing.form.content = "用户已经编辑过的正文";
    await act(async () => {
      workspace.useWorkspace.setState({ createDraft: existing });
    });
    await click("AI 助手");
    mock.flush.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () => {
      await expect(aiHost().openCreateForm("memos_create", memoDraft)).rejects.toThrow(
        "请先保存或关闭",
      );
    });
    expect(mock.flush).not.toHaveBeenCalled();
    expect(mock.openCreateDraft).not.toHaveBeenCalled();
    expect(workspace.useWorkspace.getState().createDraft).toBe(existing);
    expect(selected()).toBe("AI 助手");
  });
});
