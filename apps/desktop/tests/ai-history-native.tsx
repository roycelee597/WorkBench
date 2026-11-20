import { getIdentifier } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createRoot } from "react-dom/client";
import { aiApi } from "../../../workbenches/ai/src/api";
import { useAiStore } from "../../../workbenches/ai/src/ai-store";
import { generalApi } from "../../../workbenches/general/src/api";

const identifier = "com.royce.workbench.ai-a5-check";
const starter = "A5 离线合成对话登记";
const multiple = "A3:multiple";
const disabled = "A5 关闭记录时的合成消息";
const resumed = "A5 恢复记录后的合成消息";
const output = document.querySelector<HTMLPreElement>("#result")!;
const open = document.querySelector<HTMLButtonElement>("#open-app")!;
const state = useAiStore.getState;
const lines: string[] = [];
class VerificationFailure extends Error {}

function verify(condition: unknown, description: string): asserts condition {
  if (!condition) throw new VerificationFailure(description);
  lines.push(`通过 · ${description}`);
  output.textContent = lines.join("\n");
}

async function send(prompt: string) {
  state().setDraft(prompt);
  await state().send();
}

async function seed() {
  const now = Date.now();
  const [calendar, deletedEvents, reminders, deletedReminders, memos, key, history] =
    await Promise.all([
      generalApi.loadCalendar({ start: now, end: now + 86_400_000 }),
      generalApi.listDeletedEvents(),
      generalApi.listReminders(),
      generalApi.listDeletedReminders(),
      generalApi.load(),
      aiApi.keyStatus(),
      aiApi.loadHistory(),
    ]);
  verify(
    !key.configured &&
      !history.length &&
      !calendar.events.length &&
      !deletedEvents.length &&
      !reminders.length &&
      !deletedReminders.length &&
      !memos.memos.length &&
      !memos.deleted.length,
    "隔离实例没有业务记录和活动历史，尚未配置凭据",
  );
  await generalApi.setStoredShortcut("Ctrl+Alt+F10");
  await aiApi.setStoredShortcut("Ctrl+Alt+F11");
  await aiApi.saveHistoryEnabled(true);
  await aiApi.saveKey("sk-fake-workbench-test-ab12");
  await aiApi.appendHistory({ role: "user", text: starter });
  await send(multiple);
  const proposals = Object.entries(state().proposals);
  const memo = proposals.find(([, item]) => item.actionName === "memos_create");
  const reminder = proposals.find(([, item]) => item.actionName === "reminders_create");
  verify(memo && reminder && proposals.length === 2, "本机模拟服务生成两张待确认卡片");
  await state().confirmProposal(memo[0]);
  const initial = await aiApi.loadHistory();
  const saved = initial.find(
    (row) => row.role === "card" && row.status === "saved" && row.payload.target?.kind === "memo",
  );
  verify(
    saved &&
      initial.some((row) => row.role === "card" && row.status === "pending") &&
      (await generalApi.load()).memos.length === 1 &&
      (await generalApi.listReminders()).length === 0,
    "保存的卡片带本地跳转目标，另一张卡片仍待确认且未写业务库",
  );
  await aiApi.saveHistoryEnabled(false);
  await send(disabled);
  const unchanged = await aiApi.loadHistory();
  verify(
    state().messages.at(-1)?.role === "assistant" &&
      state().messages.some((item) => item.role === "user" && item.text === disabled) &&
      JSON.stringify(initial) === JSON.stringify(unchanged),
    "关闭保存后仍能对话，既有历史不变且新消息不落库",
  );
  await aiApi.saveHistoryEnabled(true);
  await send(resumed);
  const records = await aiApi.loadHistory();
  verify(
    records.some((row) => row.role === "user" && row.text === resumed) &&
      records.some((row) => row.role === "assistant") &&
      !records.some((row) => row.role === "user" && row.text === disabled),
    "重新开启后保存后续对话，不补写关闭期间的消息",
  );
  output.textContent += "\n\n请退出隔离实例，再用同一数据目录启动以验证恢复。";
}

async function requireSeed() {
  const records = await aiApi.loadHistory();
  const users = records.filter((row) => row.role === "user");
  verify(
    records.length === 6 &&
      users.length === 3 &&
      [starter, multiple, resumed].every((marker) => users.some((row) => row.text === marker)) &&
      records.filter((row) => row.role === "card").length === 2 &&
      records.filter((row) => row.role === "assistant").length === 1,
    "当前只包含本轮合成验收历史",
  );
  return records;
}

async function reload() {
  verify(
    !state().messages.length && !state().history.length && !Object.keys(state().proposals).length,
    "新进程中的对话内存初始为空",
  );
  const records = await requireSeed();
  await state().refresh();
  const restored = state().messages.flatMap((message) =>
    message.role === "assistant" && message.event.type === "archived" ? [message.event.record] : [],
  );
  verify(
    state().messages.length === records.length &&
      restored.some((row) => row.role === "card" && row.status === "pending") &&
      restored.some(
        (row) =>
          row.role === "card" && row.status === "saved" && row.payload.target?.kind === "memo",
      ),
    "历史恢复，未确认卡片只以历史记录显示，已保存卡片保留本地目标",
  );
  verify(
    !state().history.length &&
      !Object.keys(state().proposals).length &&
      !Object.keys(state().choices).length &&
      !Object.keys(state().refItems).length,
    "恢复的本机历史不会成为模型上下文，也不能继续执行旧卡片",
  );
  const { default: App } = await import("../src/App");
  open.hidden = false;
  open.addEventListener(
    "click",
    () => {
      const root = document.querySelector<HTMLElement>("#root")!;
      root.hidden = false;
      document.querySelector<HTMLElement>("#verification")!.hidden = true;
      createRoot(root).render(<App />);
    },
    { once: true },
  );
}

async function clear() {
  await requireSeed();
  await state().refresh();
  const cleared = await state().clear();
  verify(
    cleared && !state().messages.length && !(await aiApi.loadHistory()).length,
    "清空后界面和仓库均无活动历史",
  );
  verify((await generalApi.load()).memos.length === 1, "清空对话后已保存的业务备忘录仍在");
}

async function check() {
  verify(
    (await getIdentifier()) === identifier && getCurrentWindow().label === "main",
    "已核对 A5 离线验收专用隔离标识",
  );
  const phase =
    new URLSearchParams(location.search).get("phase") ??
    ((await aiApi.loadHistory()).some((row) => row.role === "user" && row.text === starter)
      ? "reload"
      : "seed");
  switch (phase) {
    case "seed":
      // 挂载应用之前加载已登记的操作，保证与实际工作台使用同一登记表。
      await import("../src/App");
      await seed();
      break;
    case "reload":
      await reload();
      break;
    case "clear":
      await clear();
      break;
    default:
      throw new VerificationFailure("不支持的验收阶段");
  }
}

void check().catch((error: unknown) => {
  const reason = error instanceof VerificationFailure ? error.message : "发生本地错误";
  output.textContent = [...lines, `验收中止 · ${reason}`].join("\n");
});
