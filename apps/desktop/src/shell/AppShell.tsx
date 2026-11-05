import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { GeneralWorkbench, workspace } from "@workbench/general";
import { cn } from "@workbench/ui";

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
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const current = getCurrentWindow();
    void current
      .onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          await workspace.flush();
          await current.destroy();
        } catch (error) {
          console.error("关闭前保存失败", error);
          workspace.useWorkspace.setState({
            error: "尚有修改未能保存，窗口已保留。请重试保存后再关闭。",
          });
        }
      })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch((error: unknown) => {
        console.error("注册关闭保存失败", error);
        workspace.useWorkspace.setState({
          error: "关闭前保存暂时不可用，请等待修改保存完成后再退出。",
        });
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
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
              state.page !== "settings" && state.page !== "trash" && "selected",
            )}
            disabled={!state.ready || state.busy}
            onClick={() => void state.navigate("today")}
          >
            <NavIcon type="workspace" />
            <span>综合工作台</span>
            <span className="sidebar-active-dot" />
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button
            type="button"
            className={cn("sidebar-link", state.page === "settings" && "selected")}
            disabled={!state.ready || state.busy}
            onClick={() => void state.navigate("settings")}
          >
            <NavIcon type="settings" />
            设置
          </button>
          <button
            type="button"
            className={cn("sidebar-link", state.page === "trash" && "selected")}
            disabled={!state.ready || state.busy}
            onClick={() => void state.navigate("trash")}
          >
            <NavIcon type="trash" />
            回收站
            {state.deleted.length > 0 && (
              <span className="sidebar-count">{state.deleted.length}</span>
            )}
          </button>
          <div className="sidebar-footer">
            <span className="status-dot" />
            专注当下，慢慢来。
          </div>
        </div>
      </aside>
      <main className="app-main">
        <GeneralWorkbench />
      </main>
    </div>
  );
}
