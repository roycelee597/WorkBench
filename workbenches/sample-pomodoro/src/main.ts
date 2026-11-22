import { createWorkbenchSdk, WorkbenchError } from "@workbench/sdk";
import "./styles.css";

const wb = createWorkbenchSdk();
const clock = document.querySelector<HTMLOutputElement>("#clock")!;
const toggle = document.querySelector<HTMLButtonElement>("#toggle")!;
const reset = document.querySelector<HTMLButtonElement>("#reset")!;
const save = document.querySelector<HTMLButtonElement>("#save")!;
const minutes = document.querySelector<HTMLInputElement>("#minutes")!;
const notify = document.querySelector<HTMLButtonElement>("#notify")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;

const storageKey = "focus-minutes";
let duration = 25;
let remaining = duration * 60_000;
let deadline: number | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

function describeError(error: unknown) {
  return error instanceof WorkbenchError
    ? `${error.message}（${error.code}）`
    : "操作失败，请重试。";
}

function paintClock() {
  const seconds = Math.ceil(remaining / 1000);
  const value = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  if (clock.value !== value) clock.value = value;
  toggle.textContent = deadline === undefined ? "开始" : "暂停";
}

function pause() {
  clearInterval(timer);
  timer = undefined;
  deadline = undefined;
}

function resetClock() {
  pause();
  remaining = duration * 60_000;
  paintClock();
}

async function sendNotice(body: string) {
  try {
    await wb.notifications.send({ title: "番茄钟", body });
    status.textContent = "通知已发送。";
  } catch (error) {
    status.textContent = describeError(error);
  }
}

function tick() {
  if (deadline === undefined) return;
  remaining = Math.max(0, deadline - Date.now());
  if (remaining === 0) {
    pause();
    void sendNotice("本轮专注结束，可以休息一下。");
  }
  paintClock();
}

toggle.addEventListener("click", () => {
  if (deadline !== undefined) {
    tick();
    pause();
    paintClock();
    return;
  }
  if (remaining === 0) resetClock();
  deadline = Date.now() + remaining;
  timer = setInterval(tick, 250);
  paintClock();
});
reset.addEventListener("click", resetClock);
notify.addEventListener("click", () => void sendNotice("软件内通知测试。"));
document.querySelector("form")!.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = minutes.valueAsNumber;
  if (!Number.isInteger(value) || value < 1 || value > 120) return;
  save.disabled = true;
  void wb.storage
    .set(storageKey, value)
    .then(
      () => {
        duration = value;
        resetClock();
        status.textContent = "已保存专注时长。";
      },
      (error: unknown) => {
        status.textContent = describeError(error);
      },
    )
    .finally(() => {
      save.disabled = false;
    });
});

void wb.storage
  .get(storageKey)
  .then(
    (value) => {
      if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 120) {
        duration = value;
        minutes.value = String(value);
        resetClock();
      }
    },
    (error: unknown) => {
      status.textContent = describeError(error);
    },
  )
  .finally(() => {
    save.disabled = false;
    toggle.disabled = false;
    reset.disabled = false;
  });

const applyTheme = (theme: "light" | "dark") => {
  document.documentElement.dataset.theme = theme;
};
try {
  wb.app.onThemeChange(applyTheme);
  void wb.app.getTheme().then(applyTheme, () => {});
} catch {
  // 独立预览时沿用系统颜色。
}
window.addEventListener("pagehide", () => {
  pause();
  wb.dispose();
});
