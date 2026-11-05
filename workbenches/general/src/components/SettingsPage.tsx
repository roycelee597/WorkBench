import { Monitor, Sun, Moon, Check } from "lucide-react";
import { cn } from "@workbench/ui";
import { workspace } from "../workspace-store";
import type { Theme } from "../api";
import { generalApi } from "../api";
import { reminderChoices } from "../calendar-model";
import { useEffect, useState } from "react";
const choices = [
  { value: "system", label: "跟随系统", Icon: Monitor },
  { value: "light", label: "浅色", Icon: Sun },
  { value: "dark", label: "深色", Icon: Moon },
] as const;
export function SettingsPage() {
  const state = workspace.useWorkspace();
  const [reminder, setReminder] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autostart, setAutostart] = useState(false);
  const [autoBusy, setAutoBusy] = useState(true);
  const [autoError, setAutoError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void generalApi
      .getDefaultEventReminder()
      .then((value) => {
        if (current) setReminder(value);
      })
      .catch(() => {
        if (current) setError("未能读取日程默认提醒，请重新打开设置。");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    void generalApi
      .getAutostart()
      .then((value) => {
        if (current) setAutostart(value);
      })
      .catch(() => {
        if (current) setAutoError("未能读取自启状态，请重新打开设置。");
      })
      .finally(() => {
        if (current) setAutoBusy(false);
      });
    return () => {
      current = false;
    };
  }, []);
  function choose(theme: Theme) {
    void state.setTheme(theme);
  }
  return (
    <section className="utility-page settings-page">
      <div className="utility-heading">
        <div>
          <div className="eyebrow">用你喜欢的方式</div>
          <h1>设置</h1>
          <p>让工作空间更适合自己。</p>
        </div>
      </div>
      <div className="settings-section">
        <div>
          <h2>外观</h2>
          <p>选择主题，或让 WorkBench 与系统保持一致。</p>
        </div>
        <div className="theme-choices" role="radiogroup" aria-label="外观主题">
          {choices.map(({ value, label, Icon }) => (
            <button
              type="button"
              role="radio"
              aria-checked={state.theme === value}
              tabIndex={state.theme === value ? 0 : -1}
              key={value}
              disabled={state.busy}
              onClick={() => choose(value)}
              onKeyDown={(event) => {
                if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
                  event.preventDefault();
                  const index = choices.findIndex((choice) => choice.value === value);
                  const next =
                    choices[
                      (index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? 2 : 1)) % 3
                    ]!;
                  choose(next.value);
                  (
                    event.currentTarget.parentElement?.children[
                      (index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? 2 : 1)) % 3
                    ] as HTMLElement
                  )?.focus();
                }
              }}
              className={cn("theme-choice", state.theme === value && "selected")}
            >
              <div className={`theme-preview ${value}`}>
                <span className="preview-sidebar" />
                <div className="preview-main">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
              <span>
                <Icon size={15} />
                {label}
                {state.theme === value && <Check size={15} className="ml-auto text-primary" />}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="settings-section event-default-setting">
        <div>
          <h2>日程默认提前提醒</h2>
          <p>用于新建日程，已有日程保持原来的提前量。</p>
        </div>
        <label className="event-field">
          提前量
          <select
            aria-label="日程默认提前提醒"
            disabled={loading || state.busy}
            value={reminder ?? "none"}
            onChange={async (event) => {
              const value = event.target.value === "none" ? null : Number(event.target.value);
              setLoading(true);
              setError(null);
              try {
                await generalApi.setDefaultEventReminder(value);
                setReminder(value);
              } catch {
                setError("保存失败，请重试。");
              } finally {
                setLoading(false);
              }
            }}
          >
            {reminderChoices.map((choice) => (
              <option value={choice.value ?? "none"} key={choice.value ?? "none"}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="settings-section autostart-setting">
        <div>
          <h2>开机自启</h2>
          <p>默认关闭。开启后应用会在登录 Windows 时启动并留在托盘，提醒才可持续运行。</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="开机自启"
          aria-checked={autostart}
          disabled={autoBusy || state.busy}
          className="autostart-switch"
          onClick={async () => {
            setAutoBusy(true);
            setAutoError(null);
            try {
              await generalApi.setAutostart(!autostart);
              setAutostart(await generalApi.getAutostart());
            } catch {
              setAutoError("未能更改自启设置，请重试。");
            } finally {
              setAutoBusy(false);
            }
          }}
        >
          <span />
          {autostart ? "已开启" : "已关闭"}
        </button>
        {autoError && <p role="alert">{autoError}</p>}
      </div>
    </section>
  );
}
