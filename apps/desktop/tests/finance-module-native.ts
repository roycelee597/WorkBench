import { getIdentifier } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { FINANCE_WORKBENCH } from "../src/core/finance/finance-target";
import { FinanceReader } from "../src/core/finance/finance-reader";
import { openDatabase } from "../src/core/db/database";
import { moduleApi, moduleDataLayer } from "../src/runtime/module-api";

const output = document.querySelector<HTMLPreElement>("#result")!;
const checks: string[] = [];
function verify(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  checks.push(`通过 · ${message}`);
  output.textContent = checks.join("\n");
}

async function check() {
  if (!/^com\.royce\.workbench\.p02-check-[a-z0-9]{3,16}$/.test(await getIdentifier()))
    throw new Error("这是隔离验收页，请用脚本生成的独立 identifier 启动");

  const id = FINANCE_WORKBENCH;
  const tokenStatus = () =>
    invoke<{ configured: boolean; tail: string | null }>("finance_token_status");
  const probe = () =>
    invoke<{ available: boolean }>("module_engine_call", { id, method: "probe", params: {} });
  const data = await moduleDataLayer();
  const db = openDatabase();
  const settings = () => db.select("SELECT key,value FROM settings WHERE key GLOB 'finance.*'");
  const first = await moduleApi.start();
  const old = first.modules.find(({ manifest }) => manifest.id === id);
  verify(
    old && old.grants.includes("finance") && old.grants.includes("engine"),
    "旧版升级自动装好官方包",
  );
  const thresholds = await data.financeThresholds.list();
  const custom = thresholds.find(({ label }) => label === "P0-2 旧版阈值");
  verify(custom?.level === 75, "升级保留旧阈值");
  const states = await data.financeAlertStates.list();
  verify(
    states.some(
      ({ threshold_id, evaluated_through }) =>
        threshold_id === custom.id && evaluated_through === 20261120,
    ),
    "升级保留旧提醒游标",
  );
  verify((await data.settings.getValue("finance.overlay_hs300")) === false, "升级保留金融设置");
  const token = await tokenStatus();
  verify(token.configured && token.tail === "Q4PL", "升级沿用同一个虚构凭据");
  const reader = new FinanceReader();
  const recent = await reader.getRecent(["top5_turnover_share"]);
  verify(
    recent.some(({ points }) => points.some(({ value }) => value === 43.25)),
    "升级保留旧行情",
  );
  const again = await moduleApi.start();
  verify(
    again.modules.some(({ url }) => url === old.url) &&
      (await data.financeThresholds.list()).length === thresholds.length &&
      (await tokenStatus()).tail === token.tail,
    "重复初始化不替换已激活的模块或旧状态",
  );
  verify((await probe()).available, "附带引擎摘要校验通过");
  await moduleApi.uninstall(id);
  const removed = await moduleApi.start();
  verify(
    removed.modules.every(({ manifest }) => manifest.id !== id) && !removed.pending.includes(id),
    "卸载完成且同一运行时不会自动恢复",
  );
  verify(
    !(await db.select("SELECT id FROM finance_alert_states")).length &&
      !(await db.select("SELECT id FROM finance_thresholds")).length &&
      !(await settings()).length,
    "数据库中的阈值、游标和金融设置均已清空",
  );
  verify(
    (await data.memos.list()).some(({ title }) => title === "P0-2 综合保留") &&
      (await db.select("SELECT id FROM ai_messages WHERE text = ?", ["P0-2 AI 保留"])).length === 1,
    "综合备忘录和 AI 记录仍在",
  );
  const fresh = await moduleApi.reinstallFinance();
  verify(
    fresh.manifest.id === id && (await probe()).available,
    "本地附带包可重新安装并通过引擎校验",
  );
  verify(
    !(await tokenStatus()).configured &&
      !(await reader.listIndicators()).length &&
      !(await settings()).length,
    "重装后 token、行情和设置均为干净状态",
  );
  output.textContent += "\n完成";
}

void check().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "命令失败";
  output.textContent = [...checks, `失败 · ${message}`].join("\n");
});
