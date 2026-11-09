import { useEffect, useState } from "react";
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
import { initializeQuickHost } from "./quick-bridge";
import { shortcutController } from "./shortcut-runtime";
import type { ReminderScheduler } from "../core/scheduler/scheduler";
import {
  GeneralWorkbench,
  workspace,
  generalApi,
  configureHostServices,
  onAutostartOffer,
} from "@workbench/general";
import { cn, Button, Dialog } from "@workbench/ui";
import {
  FinanceBackfillDialog,
  FinanceSettings,
  FinanceWorkbench,
  financeApi,
} from "@workbench/finance";

async function handleNotification(action: NotificationAction) {
  if (workspace.useWorkspace.getState().busy) {
    await new Promise<void>((resolve) => {
      const off = workspace.useWorkspace.subscribe((state) => {
        if (!state.busy) {
          off();
          resolve();
        }
      });
    });
  }
  if (action.kind === "missed") {
    await workspace.useWorkspace.getState().openMissed(action.count);
    const error = workspace.useWorkspace.getState().error;
    if (error) throw new Error(error);
    return;
  }
  const target = await generalApi.reminderTarget(action.occurrenceId);
  if (action.kind === "complete") await generalApi.completeReminder(target);
  else if (action.kind === "snooze") await generalApi.snoozeReminder(target);
  else {
    await workspace.useWorkspace.getState().openReminder(target);
    const error = workspace.useWorkspace.getState().error;
    if (error) throw new Error(error);
  }
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
  const [financeOpen, setFinanceOpen] = useState(false);
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
    void initializeQuickHost().catch(() =>
      workspace.useWorkspace.setState({ shortcutError: "快速新建服务未能启动，请重启应用。" }),
    );
    void shortcutController.start();
    const offOffer = onAutostartOffer(() =>
      workspace.useWorkspace.setState({ autostartOffer: true }),
    );
    let disposed = false;
    let offRequests: (() => void) | undefined;
    let scheduler: ReminderScheduler | undefined;
    let sequence = Promise.resolve();
    async function idle() {
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
    function queue(action: () => Promise<void>) {
      sequence = sequence
        .then(async () => {
          await idle();
          await action();
        })
        .catch(async (error: unknown) => {
          console.error("桌面操作失败", error);
          workspace.useWorkspace.setState({
            desktopError: error instanceof Error ? error.message : "操作未完成，请在提醒页重试。",
          });
          await invoke("show_main").catch(() => undefined);
        });
      return sequence;
    }
    async function drain() {
      const requests = await invoke<string[]>("take_shell_requests");
      for (const request of requests)
        await queue(async () => {
          if (request === "new-reminder") {
            setFinanceOpen(false);
            await workspace.useWorkspace.getState().newReminder();
          } else if (request === "hide") {
            await workspace.flush();
            await invoke("hide_main");
          } else if (request === "exit") {
            await workspace.flush();
            scheduler?.stop();
            await invoke("exit_app");
          }
        });
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
    };
  }, []);
  function openGeneral(page: "today" | "settings" | "trash") {
    setFinanceOpen(false);
    void state.navigate(page);
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
          <button
            type="button"
            className={cn(
              "sidebar-link",
              !financeOpen && state.page !== "settings" && state.page !== "trash" && "selected",
            )}
            disabled={!state.ready || state.busy}
            onClick={() => openGeneral("today")}
          >
            <NavIcon type="workspace" />
            <span>综合工作台</span>
            <span className="sidebar-active-dot" />
          </button>
          <button
            type="button"
            className={cn("sidebar-link", financeOpen && "selected")}
            disabled={!state.ready || state.busy}
            onClick={() =>
              void workspace
                .flush()
                .then(() => setFinanceOpen(true))
                .catch(() => undefined)
            }
          >
            <NavIcon type="workspace" />
            <span>金融指标</span>
            <span className="sidebar-active-dot" />
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button
            type="button"
            className={cn("sidebar-link", !financeOpen && state.page === "settings" && "selected")}
            disabled={!state.ready || state.busy}
            onClick={() => openGeneral("settings")}
          >
            <NavIcon type="settings" />
            设置
          </button>
          <button
            type="button"
            className={cn("sidebar-link", !financeOpen && state.page === "trash" && "selected")}
            disabled={!state.ready || state.busy}
            onClick={() => openGeneral("trash")}
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
            <Button size="sm" variant="outline" onClick={() => openGeneral("settings")}>
              快捷键设置
            </Button>
          </div>
        )}
        {state.desktopError && (
          <div className="desktop-error" role="alert">
            {state.desktopError}
          </div>
        )}
        <div className={financeOpen ? "hidden" : "contents"}>
          <GeneralWorkbench settingsExtra={<FinanceSettings />} />
        </div>
        {financeOpen && <FinanceWorkbench openSettings={() => openGeneral("settings")} />}
      </main>
      <ReminderNotices
        onAction={(action) => {
          if (action.kind !== "complete" && action.kind !== "snooze") setFinanceOpen(false);
          return handleNotification(action);
        }}
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
