import type { FinanceModuleSnapshot, FinanceModuleThreshold } from "@workbench/sdk";
import { z } from "zod";
import {
  financeOperations,
  financeWrite,
  subscribeFinanceHost,
} from "../core/finance/finance-host";
import { FINANCE_WORKBENCH } from "../core/finance/finance-target";
import { financeDiagnostic } from "../core/finance/local-sidecar-source";
import type { FinanceThreshold } from "../core/repositories/finance-thresholds";
import { BridgeError, method, type ModuleMethod } from "./bridge";
import type { ModuleSurface } from "./methods";
import { isModuleRemoving } from "./module-api";

const empty = z.strictObject({});
const key = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const series = z.strictObject({ keys: z.array(key).max(64) });
const id = z.uuid();
const threshold = z.strictObject({
  indicator_id: key,
  series_key: key,
  direction: z.enum(["above", "below"]),
  level: z.number(),
  hysteresis: z.number().nonnegative(),
  enabled: z.boolean(),
  label: z.string().trim().max(240),
});
const preference = z.discriminatedUnion("field", [
  z.strictObject({ field: z.literal("range"), value: z.enum(["1y", "3y", "5y", "all"]) }),
  z.strictObject({ field: z.literal("overlay"), value: z.boolean() }),
  z.strictObject({ field: z.literal("top5View"), value: z.enum(["daily", "monthly"]) }),
  z.strictObject({ field: z.literal("valuationWindow"), value: z.enum(["5y", "10y", "all"]) }),
  z.strictObject({ field: z.literal("valuationMetric"), value: z.enum(["pe_ttm", "pb"]) }),
  z.strictObject({ field: z.literal("valuationView"), value: z.enum(["percentile", "raw"]) }),
  z.strictObject({ field: z.literal("valuationIndex"), value: z.union([z.literal(""), key]) }),
  z.strictObject({ field: z.literal("indicator"), value: z.union([z.literal(""), key]) }),
]);

function thresholdViews(rows: FinanceThreshold[]): FinanceModuleThreshold[] {
  return rows.map(
    ({ id, indicator_id, series_key, direction, level, hysteresis, enabled, label }) => ({
      id,
      indicator_id,
      series_key,
      direction,
      level,
      hysteresis,
      enabled,
      label,
    }),
  );
}

export function subscribeFinanceModule(listener: (snapshot: FinanceModuleSnapshot) => void) {
  return subscribeFinanceHost((snapshot) => {
    if (!isModuleRemoving(FINANCE_WORKBENCH)) listener(snapshot);
  });
}

export function financeMethods(
  moduleId: string,
  ui: Pick<ModuleSurface, "active" | "permissions">,
): Record<string, ModuleMethod> {
  if (moduleId !== FINANCE_WORKBENCH) return {};
  function authorize(engine = false) {
    if (!ui.active() || isModuleRemoving(moduleId))
      throw new BridgeError("DISCONNECTED", "金融模块已关闭");
    if (!ui.permissions().includes("finance") || (engine && !ui.permissions().includes("engine")))
      throw new BridgeError("PERMISSION_DENIED", "金融模块未获此权限，或权限已撤销");
  }
  async function permitted<T>(action: () => T, engine = false) {
    authorize(engine);
    try {
      return await action();
    } catch (error) {
      const { code, message } = financeDiagnostic(error);
      throw new BridgeError(/^[A-Z_]{1,40}$/.test(code) ? code : "INTERNAL_ERROR", message);
    }
  }
  const read = <Params>(schema: z.ZodType<Params>, effect: (params: Params) => unknown) =>
    method(schema, "read", (params) => permitted(() => effect(params)), "finance");
  const write = <Params>(
    schema: z.ZodType<Params>,
    effect: (params: Params) => unknown,
    engine = false,
  ) =>
    method(
      schema,
      "write",
      (params) =>
        permitted(() => financeWrite(() => permitted(() => effect(params), engine)), engine),
      "finance",
    );
  return {
    "finance.snapshot": read(empty, financeOperations.snapshot),
    "finance.cacheStatus": read(empty, financeOperations.getStatus),
    "finance.listIndicators": read(empty, financeOperations.listIndicators),
    "finance.getRecent": read(series, ({ keys }) => financeOperations.getRecent(keys)),
    "finance.getSeries": read(series, ({ keys }) => financeOperations.getSeries(keys)),
    "finance.getOverlay": read(empty, financeOperations.getOverlay),
    "finance.loadThresholds": method(
      empty,
      "read",
      () =>
        permitted(() =>
          financeWrite(() =>
            permitted(async () => thresholdViews(await financeOperations.loadThresholds())),
          ),
        ),
      "finance",
    ),
    "finance.saveThreshold": write(
      z.strictObject({ fields: threshold, id: id.optional() }),
      async ({ fields, id }) => thresholdViews(await financeOperations.saveThreshold(fields, id)),
    ),
    "finance.deleteThreshold": write(z.strictObject({ id }), async ({ id }) =>
      thresholdViews(await financeOperations.deleteThreshold(id)),
    ),
    "finance.loadPreferences": read(empty, financeOperations.loadPreferences),
    "finance.savePreference": write(preference, ({ field, value }) =>
      financeOperations.savePreference(field, value),
    ),
    "finance.loadFallback": read(empty, financeOperations.loadFallback),
    "finance.saveFallback": write(z.strictObject({ enabled: z.boolean() }), ({ enabled }) =>
      financeOperations.saveFallback(enabled),
    ),
    "finance.requestUpdate": write(
      z.strictObject({ mode: z.enum(["auto", "full-rebuild"]) }),
      ({ mode }) => financeOperations.requestUpdate(mode),
      true,
    ),
    "finance.cancelUpdate": method(
      empty,
      "write",
      () => permitted(financeOperations.cancelUpdate, true),
      "finance",
    ),
    "finance.saveToken": write(
      z.strictObject({ token: z.string().trim().min(1).max(4096) }),
      ({ token }) => financeOperations.saveToken(token),
      true,
    ),
    "finance.clearToken": write(empty, financeOperations.clearToken),
    "finance.verify": method(
      empty,
      "interaction",
      () => permitted(financeOperations.verify, true),
      "finance",
    ),
    "finance.openDirectory": read(empty, financeOperations.openDirectory),
    "finance.dismissBackfill": write(empty, financeOperations.dismissBackfill),
    "finance.approveBackfill": write(empty, financeOperations.approveBackfill, true),
  };
}
