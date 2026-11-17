import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { isTauri, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { initializeReminderRuntime } from "../core/scheduler/runtime";
import {
  createInAppNotificationPort,
  type NotificationAction,
} from "../core/scheduler/notification-port";
import { useReminderNotices } from "./reminder-notices";
import { ReminderNotices } from "./ReminderNotices";
import { dispatchNotification } from "./notification-action";
import { initializeQuickHost } from "./quick-bridge";
import {
  aiShortcutController,
  configureAiShortcutOpening,
  getAiShortcutStatus,
  shortcutController,
  subscribeAiShortcutStatus,
} from "./shortcut-runtime";
import type { ReminderScheduler } from "../core/scheduler/scheduler";
import {
  GeneralWorkbench,
  workspace,
  generalApi,
  configureHostServices,
  onAutostartOffer,
  generalAiActions,
  openAiTarget,
} from "@workbench/general";
import { aiRegistry } from "../core/ai/registry";
import { cn, Button, Dialog } from "@workbench/ui";
import { FinanceBackfillDialog, FinanceSettings, financeApi } from "@workbench/finance";
import { AiSettings, configureAiHostServices } from "@workbench/ai";

const FinanceWorkbench = lazy(() =>
  import("@workbench/finance/page").then((module) => ({ default: module.FinanceWorkbench })),
);
const AiWorkbench = lazy(() =>
  import("@workbench/ai/page").then((module) => ({ default: module.AiWorkbench })),
);
if (!aiRegistry.get("reminders_create")) aiRegistry.register(generalAiActions);
const builtinWorkbenches = [
  { id: "general", name: "综合工作台", icon: "workspace", component: GeneralWorkbench },
  { id: "finance", name: "金融指标", icon: "workspace", component: FinanceWorkbench },
  { id: "ai", name: "AI 助手", icon: "workspace", component: AiWorkbench },
] as const;
type BuiltinWorkbench = (typeof builtinWorkbenches)[number]["id"];

async function waitForWorkspace() {
  if (!workspace.useWorkspace.getState().busy) return;
  await new Promise<void>((resolve) => {
    const off = workspace.useWorkspace.subscribe((state) => {
      if (!state.busy) {
        off();
        resolve();
      }
    });
  });
}

function ensureWorkspaceNavigation() {
  const error = workspace.useWorkspace.getState().error;
  if (error) throw new Error(error);
}

async function handleNotification(
  action: NotificationAction,
  navigation: { openFinance: (reminderId: string) => Promise<void>; showGeneral: () => void },
) {
  await waitForWorkspace();
  async function openGeneral(open: () => Promise<unknown>) {
    await open();
    ensureWorkspaceNavigation();
    navigation.showGeneral();
  }
  return dispatchNotification(action, {
    resolve: generalApi.reminderTarget,
    complete: generalApi.completeReminder,
    snooze: generalApi.snoozeReminder,
    openFinance: navigation.openFinance,
    openMissed: (count) => openGeneral(() => workspace.useWorkspace.getState().openMissed(count)),
    openReminder: (target) =>
      openGeneral(() => workspace.useWorkspace.getState().openReminder(target)),
  });
}

function NavIcon({ type }: { type: "workspace" | "settings" | "trash" }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {type === "workspace" ? (
        <>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </>
      ) : type === "trash" ? (
        <>
          <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
        </>
      ) : (
        <>
          <path d="m9.5 3-.7 2.2-2 .9-2.1-.5-2 3.5 1.5 1.7v2.4l-1.5 1.7 2 3.5 2.1-.5 2 .9.7 2.2h4.1l.7-2.2 2-.9 2.1.5 2-3.5-1.5-1.7v-2.4l1.5-1.7-2-3.5-2.1.5-2-.9-.7-2.2z" />
          <circle cx="11.5" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}
export function AppShell() {
  const state = workspace.useWorkspace();
  const [activeWorkbench, setActiveWorkbench] = useState<BuiltinWorkbench>("general");
  const [financeNavigation, setFinanceNavigation] = useState(0);
  const [aiFocusVersion, setAiFocusVersion] = useState(0);
  const aiShortcut = useSyncExternalStore(subscribeAiShortcutStatus, getAiShortcutStatus);
  const [enabling, setEnabling] = useState(false);
  const [offerError, setOfferError] = useState<string | null>(null);
  useEffect(() => financeApi.startRuntime(), []);
  useEffect(() => {
    if (!isTauri()) return;
    configureHostServices({
      getAutostart: isEnabled,
      getShortcut: async () => {
        await shortcutController.start();
        return shortcutController.getStatus();
      },
      setShortcut: (value) => shortcutController.configure(value),
      setAutostart: async (enabled) => {
        if (enabled) await enable();
        else await disable();
      },
    });
    configureAiHostServices({
      getShortcut: async () => {
        await aiShortcutController.start();
        return aiShortcutController.getStatus();
      },
      setShortcut: (value) => aiShortcutController.configure(value),
      openTarget: (target) =>
        queue(async () => {
          await workspace.flush();
          await openAiTarget(target);
          setActiveWorkbench("general");
        }),
      openCreateForm: (actionName, draft) =>
        queue(async () => {
          if (workspace.useWorkspace.getState().createDraft)
            throw new Error("请先保存或关闭已打开的新建表单");
          await workspace.flush();
          await workspace.useWorkspace.getState().openCreateDraft(actionName, draft);
          ensureWorkspaceNavigation();
          setActiveWorkbench("general");
        }),
    });
    void initializeQuickHost().catch(() =>
      workspace.useWorkspace.setState({ shortcutError: "快速新建服务未能启动，请重启应用。" }),
    );
    const offOffer = onAutostartOffer(() =>
      workspace.useWorkspace.setState({ autostartOffer: true }),
    );
    let disposed = false;
    let offRequests: (() => void) | undefined;
    let scheduler: ReminderScheduler | undefined;
    let sequence = Promise.resolve();
    function queue(action: () => Promise<void>) {
      const pending = sequence.then(async () => {
        await waitForWorkspace();
        await action();
      });
      sequence = pending.catch(async (error: unknown) => {
        console.error("桌面操作失败", error);
        workspace.useWorkspace.setState({
          desktopError: error instanceof Error ? error.message : "操作未完成，请在提醒页重试。",
        });
        await invoke("show_main").catch(() => undefined);
      });
      return pending;
    }
    const offAiOpening = configureAiShortcutOpening(async () => {
      await invoke("show_main");
      await queue(async () => {
        await workspace.flush();
        setActiveWorkbench("ai");
        setAiFocusVersion((value) => value + 1);
      });
    });
    void shortcutController.start();
    void aiShortcutController.start();
    async function drain() {
      const requests = await invoke<string[]>("take_shell_requests");
      for (const request of requests)
        await queue(async () => {
          if (request === "new-reminder") {
            await workspace.useWorkspace.getState().newReminder();
            ensureWorkspaceNavigation();
            setActiveWorkbench("general");
          } else if (request === "hide") {
            await workspace.flush();
            await invoke("hide_main");
          } else if (request === "exit") {
            await workspace.flush();
            scheduler?.stop();
            await invoke("exit_app");
          }
        }).catch(() => undefined);
    }
    void listen("shell-requests", () => {
      void drain().catch((error: unknown) => {
        console.error("读取托盘请求失败", error);
      });
    })
      .then((off) => {
        if (disposed) off();
        else offRequests = off;
        return drain();
      })
      .catch((error: unknown) => {
        console.error("桌面生命周期初始化失败", error);
        workspace.useWorkspace.setState({ desktopError: "桌面控制暂不可用，请重启应用。" });
      });
    void initializeReminderRuntime(
      createInAppNotificationPort({
        showMain: () => invoke("show_main"),
        push: (message) => useReminderNotices.getState().push(message),
      }),
      () =>
        workspace.useWorkspace.setState({
          desktopError: "提醒显示暂不可用，应用会在稍后重试。",
        }),
      () => workspace.useWorkspace.setState({ desktopError: null }),
    )
      .then((value) => {
        scheduler = value;
      })
      .catch((error: unknown) => {
        console.error("提醒服务初始化失败", error);
        workspace.useWorkspace.setState({ desktopError: "提醒服务暂不可用，请重启应用。" });
      });
    return () => {
      disposed = true;
      offRequests?.();
      offOffer();
      offAiOpening();
    };
  }, []);
  async function openGeneral(page: "today" | "settings" | "trash") {
    await waitForWorkspace();
    await workspace.useWorkspace.getState().navigate(page);
    ensureWorkspaceNavigation();
    setActiveWorkbench("general");
  }
  function reportNavigation(error: unknown) {
    workspace.useWorkspace.setState({
      desktopError: error instanceof Error ? error.message : "未能打开工作台，请重试。",
    });
  }
  function navigateGeneral(page: "today" | "settings" | "trash") {
    void openGeneral(page).catch(reportNavigation);
  }
  function openAiSettings() {
    void openGeneral("settings")
      .then(() => {
        requestAnimationFrame(() => {
          document.getElementById("ai-settings-heading")?.scrollIntoView({ block: "start" });
        });
      })
      .catch(reportNavigation);
  }
  async function openWorkbench(id: BuiltinWorkbench) {
    if (id === "general") return openGeneral("today");
    await workspace.flush();
    setActiveWorkbench(id);
    if (id === "ai") setAiFocusVersion((value) => value + 1);
  }
  function manualCreate() {
    void waitForWorkspace()
      .then(() => workspace.useWorkspace.getState().newReminder())
      .then(() => {
        ensureWorkspaceNavigation();
        setActiveWorkbench("general");
      })
      .catch(reportNavigation);
  }
  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="工作台切换栏">
        <div className="brand">
          <span className="brand-mark">W</span>
          <div>
            <strong>WorkBench</strong>
            <span>留给日常的空间</span>
          </div>
        </div>
        <p className="sidebar-section-title">工作空间</p>
        <nav>
          {builtinWorkbenches.map((workbench) => (
            <button
              key={workbench.id}
              type="button"
              className={cn(
                "sidebar-link",
                activeWorkbench === workbench.id &&
                  (workbench.id !== "general" ||
                    (state.page !== "settings" && state.page !== "trash")) &&
                  "selected",
              )}
              disabled={!state.ready || state.busy}
              onClick={() => void openWorkbench(workbench.id).catch(reportNavigation)}
            >
              <NavIcon type={workbench.icon} />
              <span>{workbench.name}</span>
              <span className="sidebar-active-dot" />
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            type="button"
            className={cn(
              "sidebar-link",
              activeWorkbench === "general" && state.page === "settings" && "selected",
            )}
            disabled={!state.ready || state.busy}
            onClick={() => navigateGeneral("settings")}
          >
            <NavIcon type="settings" />
            设置
          </button>
          <button
            type="button"
            className={cn(
              "sidebar-link",
              activeWorkbench === "general" && state.page === "trash" && "selected",
            )}
            disabled={!state.ready || state.busy}
            onClick={() => navigateGeneral("trash")}
          >
            <NavIcon type="trash" />
            回收站
            {state.deleted.length + state.deletedEvents.length + state.deletedReminders.length >
              0 && (
              <span className="sidebar-count">
                {state.deleted.length + state.deletedEvents.length + state.deletedReminders.length}
              </span>
            )}
          </button>
          <div className="sidebar-footer">
            <span className="status-dot" />
            专注当下，慢慢来。
          </div>
        </div>
      </aside>
      <main className="app-main">
        {state.shortcutError && (
          <div className="desktop-error" role="alert">
            {state.shortcutError}
            <Button size="sm" variant="outline" onClick={() => navigateGeneral("settings")}>
              快捷键设置
            </Button>
          </div>
        )}
        {aiShortcut.error && (
          <div className="desktop-error" role="alert">
            {aiShortcut.error}
            <Button size="sm" variant="outline" onClick={openAiSettings}>
              AI 快捷键设置
            </Button>
          </div>
        )}
        {state.desktopError && (
          <div className="desktop-error" role="alert">
            {state.desktopError}
          </div>
        )}
        <div className={activeWorkbench === "general" ? "contents" : "hidden"}>
          <GeneralWorkbench
            active={activeWorkbench === "general"}
            settingsExtra={
              <>
                <AiSettings />
                <FinanceSettings />
              </>
            }
          />
        </div>
        {activeWorkbench === "finance" && (
          <Suspense
            fallback={
              <p className="p-6" role="status">
                正在打开金融指标…
              </p>
            }
          >
            <FinanceWorkbench
              key={financeNavigation}
              openSettings={() => navigateGeneral("settings")}
            />
          </Suspense>
        )}
        {activeWorkbench === "ai" && (
          <Suspense
            fallback={
              <p className="p-6" role="status">
                正在打开 AI 助手…
              </p>
            }
          >
            <AiWorkbench
              openSettings={openAiSettings}
              manualCreate={manualCreate}
              focusVersion={aiFocusVersion}
            />
          </Suspense>
        )}
      </main>
      <ReminderNotices
        onAction={(action) =>
          handleNotification(action, {
            showGeneral: () => setActiveWorkbench("general"),
            async openFinance(reminderId) {
              await workspace.flush();
              await financeApi.openReminder(reminderId);
              setFinanceNavigation((value) => value + 1);
              setActiveWorkbench("finance");
            },
          })
        }
      />
      <FinanceBackfillDialog />
      <Dialog
        open={state.autostartOffer}
        onOpenChange={(open) => {
          if (!open && !enabling) workspace.useWorkspace.setState({ autostartOffer: false });
        }}
        title="开启开机自启？"
        description="开启开机自启，重启电脑后提醒才能准时？"
        footer={
          <>
            <Button
              variant="outline"
              autoFocus
              disabled={enabling}
              onClick={() => workspace.useWorkspace.setState({ autostartOffer: false })}
            >
              暂不
            </Button>
            <Button
              disabled={enabling}
              onClick={async () => {
                setEnabling(true);
                setOfferError(null);
                try {
                  await generalApi.setAutostart(true);
                  workspace.useWorkspace.setState({ autostartOffer: false });
                } catch {
                  setOfferError("未能开启，请稍后在设置页重试。");
                } finally {
                  setEnabling(false);
                }
              }}
            >
              {enabling ? "正在开启…" : "开启"}
            </Button>
          </>
        }
      >
        {offerError && (
          <p role="alert" className="event-form-error">
            {offerError}
          </p>
        )}
      </Dialog>
    </div>
  );
}
