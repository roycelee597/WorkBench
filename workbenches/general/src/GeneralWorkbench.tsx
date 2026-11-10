import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Sun, FileText, CalendarDays, Bell, CircleAlert } from "lucide-react";
import { Button, cn } from "@workbench/ui";
import { workspace } from "./workspace-store";
import { TodayPage } from "./components/TodayPage";
import { MemosPage } from "./components/MemosPage";
import { SettingsPage } from "./components/SettingsPage";
import { TrashPage } from "./components/TrashPage";
const CalendarPage = lazy(() =>
  import("./components/CalendarPage").then((module) => ({ default: module.CalendarPage })),
);
const RemindersPage = lazy(() =>
  import("./components/RemindersPage").then((module) => ({ default: module.RemindersPage })),
);

const tabs = [
  { page: "today", label: "今天", Icon: Sun },
  { page: "memos", label: "备忘录", Icon: FileText },
  { page: "calendar", label: "日程", Icon: CalendarDays },
  { page: "reminders", label: "提醒事项", Icon: Bell },
] as const;
export function GeneralWorkbench({ settingsExtra }: { settingsExtra?: ReactNode } = {}) {
  const state = workspace.useWorkspace();
  const initialize = state.initialize;
  useEffect(() => {
    void initialize();
  }, [initialize]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = state.theme === "dark" || (state.theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [state.theme]);
  if (!state.ready)
    return (
      <div className="initial-screen">
        <div className="empty-icon">
          <FileText size={28} />
        </div>
        <h1>{state.loading ? "正在打开工作空间…" : "暂时无法打开工作空间"}</h1>
        {state.error && (
          <>
            <p role="alert">{state.error}</p>
            <Button className="mt-5" onClick={() => void state.initialize()}>
              重新尝试
            </Button>
          </>
        )}
      </div>
    );
  const utility = state.page === "settings" || state.page === "trash";
  return (
    <div className="general-workbench">
      <header className="workspace-header">
        <div>
          <span className="workspace-eyebrow">
            我的工作空间 <span>/</span>{" "}
            {utility ? (state.page === "settings" ? "设置" : "回收站") : "综合工作台"}
          </span>
          <h1>
            {utility ? (state.page === "settings" ? "工作空间设置" : "整理与恢复") : "综合工作台"}
          </h1>
        </div>
        <div className="local-badge">
          <span className="status-dot" />
          本地工作空间
        </div>
      </header>
      {state.error && (
        <div className="error-banner" role="alert">
          <CircleAlert size={16} />
          <span>{state.error}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void workspace
                .flush()
                .then(() => workspace.useWorkspace.setState({ error: null }))
                .catch(() => undefined)
            }
          >
            重试保存
          </Button>
        </div>
      )}
      {!utility && (
        <div className="workbench-tabs" role="tablist" aria-label="综合工作台页签">
          {tabs.map(({ page, label, Icon }, index) => (
            <button
              key={page}
              type="button"
              role="tab"
              id={`tab-${page}`}
              aria-selected={state.page === page}
              aria-controls="general-panel"
              tabIndex={state.page === page ? 0 : -1}
              disabled={state.busy}
              className={cn(state.page === page && "selected")}
              onClick={() => void state.navigate(page)}
              onKeyDown={(event) => {
                if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? 3
                        : (index + (event.key === "ArrowRight" ? 1 : 3)) % 4;
                  document.getElementById(`tab-${tabs[next]!.page}`)?.focus();
                  void state.navigate(tabs[next]!.page);
                }
              }}
            >
              <Icon size={16} />
              {label}
              {page === "memos" && state.memos.length > 0 && <span>{state.memos.length}</span>}
            </button>
          ))}
        </div>
      )}
      <div
        className="workspace-panel"
        id="general-panel"
        role={utility ? undefined : "tabpanel"}
        aria-labelledby={utility ? undefined : `tab-${state.page}`}
      >
        {state.page === "today" && state.missedCount > 0 && (
          <div className="missed-reminders-banner">
            <Bell size={18} />
            <span>你有 {state.missedCount} 条错过的提醒。</span>
            <Button size="sm" variant="outline" onClick={() => void state.navigate("reminders")}>
              查看提醒
            </Button>
          </div>
        )}
        {state.page === "memos" ? (
          <MemosPage />
        ) : state.page === "settings" ? (
          <SettingsPage extra={settingsExtra} />
        ) : state.page === "trash" ? (
          <TrashPage />
        ) : state.page === "calendar" ? (
          <Suspense
            fallback={
              <p className="p-6" role="status">
                正在打开日历…
              </p>
            }
          >
            <CalendarPage key={state.calendarNavigationVersion} focus={state.calendarTarget} />
          </Suspense>
        ) : state.page === "reminders" ? (
          <Suspense
            fallback={
              <p className="p-6" role="status">
                正在打开提醒…
              </p>
            }
          >
            <RemindersPage
              key={state.reminderNavigationVersion}
              focus={state.reminderTarget}
              createRequested={state.reminderCreate}
            />
          </Suspense>
        ) : (
          <TodayPage />
        )}
      </div>
    </div>
  );
}
