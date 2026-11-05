import { Monitor, Sun, Moon, Check } from "lucide-react";
import { cn } from "@workbench/ui";
import { workspace } from "../workspace-store";
import type { Theme } from "../api";
const choices = [
  { value: "system", label: "跟随系统", Icon: Monitor },
  { value: "light", label: "浅色", Icon: Sun },
  { value: "dark", label: "深色", Icon: Moon },
] as const;
export function SettingsPage() {
  const state = workspace.useWorkspace();
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
    </section>
  );
}
