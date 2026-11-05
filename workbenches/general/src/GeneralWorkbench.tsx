import { lazy, Suspense, useEffect, useState } from "react";
import { Sun, FileText, CalendarDays, Bell, ArrowUpRight, CircleAlert, Leaf } from "lucide-react";
import { Button, cn } from "@workbench/ui";
import { workspace, type Page } from "./workspace-store";
import { MemosPage } from "./components/MemosPage";
import { SettingsPage } from "./components/SettingsPage";
import { TrashPage } from "./components/TrashPage";
const CalendarPage = lazy(() =>
  import("./components/CalendarPage").then((module) => ({ default: module.CalendarPage })),
);

const tabs = [
  { page: "today", label: "今天", Icon: Sun },
  { page: "memos", label: "备忘录", Icon: FileText },
  { page: "calendar", label: "日程", Icon: CalendarDays },
  { page: "reminders", label: "提醒事项", Icon: Bell },
] as const;
function Placeholder({ page }: { page: Page }) {
  const state = workspace.useWorkspace();
  const [today] = useState(() => Date.now());
  const tab = tabs.find((tab) => tab.page === page) ?? tabs[0];
  return (
    <section className="placeholder-page">
      <div className="placeholder-date">
        {new Intl.DateTimeFormat("zh-CN", {
          month: "long",
          day: "numeric",
          weekday: "long",
        }).format(today)}
      </div>
      <div className="placeholder-surface">
        <div className="empty-icon">
          <tab.Icon size={30} strokeWidth={1.3} />
        </div>
        <span className="coming-soon">准备中</span>
        <h1>
          {page === "today"
            ? "把今天的想法，先记下来。"
            : page === "calendar"
              ? "为重要的事，留出时间。"
              : "让每一件小事，都有着落。"}
        </h1>
        <p>
          {page === "today"
            ? "每日概览将在这里汇集。现在，先用备忘录整理思绪。"
            : `${tab.label}功能正在准备中，先记录你想记住的事吧。`}
        </p>
        <Button className="mt-6" onClick={() => void state.navigate("memos")}>
          打开备忘录
          <ArrowUpRight />
        </Button>
        <div className="placeholder-bottom">
          <Leaf size={14} />
          一处安静的空间，装下你的日常。
        </div>
      </div>
    </section>
  );
}

export function GeneralWorkbench() {
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
        {state.page === "memos" ? (
          <MemosPage />
        ) : state.page === "settings" ? (
          <SettingsPage />
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
            <CalendarPage />
          </Suspense>
        ) : (
          <Placeholder page={state.page} />
        )}
      </div>
    </div>
  );
}
