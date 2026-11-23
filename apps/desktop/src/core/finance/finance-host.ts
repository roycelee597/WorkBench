import { invoke, isTauri } from "@tauri-apps/api/core";
import type { FinanceModuleSnapshot, FinanceTokenStatus, FinancePreferences } from "@workbench/sdk";
import { createStore } from "zustand/vanilla";
import { sequenceModuleWrite, isModuleRemoving } from "../../runtime/module-api";
import {
  preferenceKeys,
  preferencesForTarget,
  readPreferences,
} from "../../../../../workbenches/finance/src/preferences";
import type { ThresholdInput } from "../repositories/finance-thresholds";
import { FINANCE_WORKBENCH } from "./finance-target";
import { FinanceAlerts } from "./finance-alerts";
import {
  callFinanceEngine,
  financeDiagnostic,
  LocalSidecarSource,
  type UpdateMode,
} from "./local-sidecar-source";
import { scheduleFinanceStartupUpdate } from "./startup-update";

const source = new LocalSidecarSource();
const confirmedKey = "finance.initial_backfill_confirmed";
const fallbackKey = "finance.akshare_fallback";

async function financeData() {
  const { initializeDataLayer } = await import("../repositories/initialize");
  return initializeDataLayer();
}

const financeSettings = async () => (await financeData()).settings;
const alerts = new FinanceAlerts(source, financeData, Date.now, reportError);
const initialState = { token: null, confirmBackfill: false, error: null };
export const financeState = createStore<Omit<FinanceModuleSnapshot, "update">>()(
  () => initialState,
);

function reportError(error: unknown) {
  if (!isModuleRemoving(FINANCE_WORKBENCH))
    financeState.setState({ error: financeDiagnostic(error).message });
}

async function refreshToken() {
  const token = await invoke<FinanceTokenStatus>("finance_token_status");
  financeState.setState({ token });
  return token;
}

async function requestUpdate(mode: UpdateMode = "auto"): Promise<void> {
  financeState.setState({ error: null });
  try {
    const token = financeState.getState().token ?? (await refreshToken());
    if (!token.configured) return;
    const settings = await financeSettings();
    const confirmed = (await settings.getValue(confirmedKey)) === true;
    if (mode === "auto" && !confirmed) {
      financeState.setState({ confirmBackfill: true });
      return;
    }
    if (mode === "full-rebuild" && !confirmed) await settings.setValue(confirmedKey, true);
    // 旧缓存先建立静默基线，保留升级前游标，并避免吞掉首次增量中的越线。
    await alerts.evaluate(mode).catch(reportError);
    await source.requestUpdate(mode, (await settings.getValue(fallbackKey)) !== false);
  } catch (error) {
    reportError(error);
  }
}

async function saveToken(token: string) {
  financeState.setState({
    token: await invoke<FinanceTokenStatus>("finance_token_set", { token }),
  });
  await requestUpdate();
}

async function clearToken() {
  await invoke("finance_token_clear");
  financeState.setState({ token: { configured: false, tail: null }, confirmBackfill: false });
}

async function approveBackfill() {
  try {
    const settings = await financeSettings();
    await settings.setValue(confirmedKey, true);
    financeState.setState({ confirmBackfill: false });
    await requestUpdate();
  } catch (error) {
    reportError(error);
  }
}

export function financeWrite<T>(run: () => Promise<T>): Promise<T> {
  return sequenceModuleWrite(FINANCE_WORKBENCH, run);
}

function snapshot(): FinanceModuleSnapshot {
  return { ...financeState.getState(), update: source.getSnapshot() };
}

// 调用本对象的写方法必须经过 financeWrite，由宿主的生命周期队列统一排空。
export const financeOperations = {
  snapshot,
  getStatus: () => source.getStatus(),
  listIndicators: () => source.listIndicators(),
  getRecent: (keys: string[]) => source.getRecent(keys),
  getSeries: (keys: string[]) => source.getSeries(keys),
  getOverlay: () => source.getOverlay(),
  loadThresholds: () => alerts.list(),
  saveThreshold: (fields: ThresholdInput, id?: string) => alerts.save(fields, id),
  deleteThreshold: (id: string) => alerts.delete(id),
  async loadFallback() {
    return (await (await financeSettings()).getValue(fallbackKey)) !== false;
  },
  async saveFallback(enabled: boolean) {
    await (await financeSettings()).setValue(fallbackKey, enabled);
  },
  async loadPreferences() {
    const settings = await financeSettings();
    const entries = await Promise.all(
      Object.entries(preferenceKeys).map(async ([field, key]) => [
        field,
        await settings.getValue(key),
      ]),
    );
    return readPreferences(Object.fromEntries(entries));
  },
  async savePreference<K extends keyof FinancePreferences>(field: K, value: FinancePreferences[K]) {
    await (await financeSettings()).setValue(preferenceKeys[field], value);
  },
  requestUpdate,
  saveToken,
  clearToken,
  approveBackfill,
  dismissBackfill: () => financeState.setState({ confirmBackfill: false }),
  verify: () => callFinanceEngine<void>("start", { input: { operation: "verify" } }),
  cancelUpdate: () => callFinanceEngine<void>("cancel", {}),
  openDirectory: () => invoke<void>("finance_open_directory"),
};

export const financeHost = {
  async openReminder(reminderId: string) {
    await financeWrite(async () => {
      const { financeAlertStates, settings } = await financeData();
      const target = await financeAlertStates.targetForReminder(reminderId);
      if (!target) return;
      const preferences = preferencesForTarget(target, await source.listIndicators());
      for (const [field, value] of Object.entries(preferences))
        await settings.setValue(preferenceKeys[field as keyof FinancePreferences], value);
    });
  },
  startRuntime(autoUpdate = true): () => void {
    if (!isTauri()) return () => undefined;
    let active = true;
    const schedule = (run: () => Promise<unknown>) =>
      financeWrite(async () => {
        if (active) await run();
      }).catch((error: unknown) => {
        if (active) reportError(error);
      });
    const unsubscribe = source.onExit((mode) => {
      void schedule(() => alerts.evaluate(mode));
    });
    void schedule(async () => {
      await alerts.evaluate().catch(reportError);
      await refreshToken();
    });
    void source.connect().catch(reportError);
    const stop = autoUpdate
      ? scheduleFinanceStartupUpdate(() => void schedule(requestUpdate))
      : () => undefined;
    return () => {
      active = false;
      stop();
      unsubscribe();
    };
  },
  reset() {
    financeState.setState(initialState);
    source.reset();
  },
};

export function subscribeFinanceHost(listener: (state: FinanceModuleSnapshot) => void) {
  const deliver = () => listener(snapshot());
  const unsubscribeState = financeState.subscribe(deliver);
  const unsubscribeSource = source.subscribe(deliver);
  return () => {
    unsubscribeState();
    unsubscribeSource();
  };
}
