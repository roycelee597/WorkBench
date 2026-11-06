import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { QuickCreateForm } from "@workbench/general";
import { quickPreferencesSchema, type QuickPreferences } from "../core/quick-create-contract";
import { sendQuickRequest } from "./quick-bridge";

export function QuickCreateWindow() {
  const [preferences, setPreferences] = useState<QuickPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const busy = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    let current = true;
    let off: (() => void) | undefined;
    const load = async (opened = false) => {
      try {
        const result = quickPreferencesSchema.parse(
          await sendQuickRequest({ type: "preferences" }),
        );
        if (current) {
          if (opened && !busy.current && !dirty.current) setVersion((value) => value + 1);
          setPreferences(result);
          setError(null);
        }
      } catch {
        if (current) setError("未能连接主窗口，请重新打开 WorkBench。");
      }
    };
    void load();
    void listen("quick-opened", () => {
      void load(true);
    })
      .then((value) => {
        if (current) off = value;
        else value();
      })
      .catch(console.error);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && !busy.current) {
        event.preventDefault();
        void invoke("hide_quick_create");
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      current = false;
      off?.();
      window.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark =
        preferences?.theme === "dark" || (preferences?.theme !== "light" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [preferences]);
  return (
    <main className="quick-window">
      <header>
        <span className="eyebrow">随手记，稍后整理</span>
        <h1>快速新建</h1>
      </header>
      {error && (
        <p role="alert" className="event-form-error">
          {error}
        </p>
      )}
      {preferences ? (
        <QuickCreateForm
          key={version}
          onBusy={(value) => {
            busy.current = value;
          }}
          onDirty={() => {
            dirty.current = true;
          }}
          onClose={() => {
            void invoke("hide_quick_create");
          }}
          onSave={async (input) => {
            await sendQuickRequest({ type: "create", input });
            dirty.current = false;
            setVersion((value) => value + 1);
            await invoke("hide_quick_create").catch(() =>
              setError("已保存，窗口暂未关闭，请按 Esc 重试。"),
            );
          }}
        />
      ) : (
        <p role="status">正在连接工作空间…</p>
      )}
    </main>
  );
}
