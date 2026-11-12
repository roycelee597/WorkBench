import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { create } from "zustand";
import {
  financeDiagnostic,
  LocalSidecarSource,
  type UpdateMode,
} from "../../../apps/desktop/src/core/finance/local-sidecar-source";
import type { FinanceStatus } from "../../../apps/desktop/src/core/finance/finance-reader";
import { scheduleFinanceStartupUpdate } from "../../../apps/desktop/src/core/finance/startup-update";
import { FinanceAlerts } from "../../../apps/desktop/src/core/finance/finance-alerts";
import type { ThresholdInput } from "../../../apps/desktop/src/core/repositories/finance-thresholds";
import {
  preferenceKeys,
  preferencesForTarget,
  readPreferences,
  type FinancePreferences,
} from "./preferences";

type TokenStatus = { configured: boolean; tail: string | null };
const source = new LocalSidecarSource();
const confirmedKey = "finance.initial_backfill_confirmed";
let preferenceWrites = Promise.resolve();

async function financeData() {
  const { initializeDataLayer } =
    await import("../../../apps/desktop/src/core/repositories/initialize");
  return initializeDataLayer();
}
const financeSettings = async () => (await financeData()).settings;
const alerts = new FinanceAlerts(source, financeData);

export const useFinanceState = create<{
  token: TokenStatus | null;
  confirmBackfill: boolean;
  error: string | null;
}>(() => ({ token: null, confirmBackfill: false, error: null }));

async function refreshToken() {
  const token = await invoke<TokenStatus>("finance_token_status");
  useFinanceState.setState({ token });
  return token;
}

function reportError(error: unknown) {
  useFinanceState.setState({ error: financeDiagnostic(error).message });
}

async function requestUpdate(mode: UpdateMode = "auto"): Promise<void> {
  useFinanceState.setState({ error: null });
  try {
    const token = useFinanceState.getState().token ?? (await refreshToken());
    if (!token.configured) return;
    const settings = await financeSettings();
    const confirmed = (await settings.getValue(confirmedKey)) === true;
    if (mode === "auto" && !confirmed) {
      useFinanceState.setState({ confirmBackfill: true });
      return;
    }
    if (mode === "full-rebuild" && !confirmed) await settings.setValue(confirmedKey, true);
    // 先给现有缓存建立静默基线，避免升级后的首次增量吞掉真正的新越线。
    if (mode === "full-rebuild") await alerts.list().catch(reportError);
    else await alerts.list();
    await source.requestUpdate(mode);
  } catch (error) {
    reportError(error);
  }
}

export const financeApi = {
  listIndicators: () => source.listIndicators(),
  getRecent: (keys: string[]) => source.getRecent(keys),
  getSeries: (keys: string[]) => source.getSeries(keys),
  getOverlay: () => source.getOverlay(),
  loadThresholds: () => alerts.list(),
  saveThreshold: (fields: ThresholdInput, id?: string) => alerts.save(fields, id),
  deleteThreshold: (id: string) => alerts.delete(id),
  async openReminder(reminderId: string) {
    const target = await (await financeData()).financeAlertStates.targetForReminder(reminderId);
    if (!target) return;
    const preferences = preferencesForTarget(target, await source.listIndicators());
    for (const [field, value] of Object.entries(preferences))
      await financeApi.savePreference(field as keyof FinancePreferences, value);
  },
  async loadPreferences(): Promise<FinancePreferences> {
    await preferenceWrites;
    const settings = await financeSettings();
    const entries = await Promise.all(
      Object.entries(preferenceKeys).map(async ([field, key]) => [
        field,
        await settings.getValue(key),
      ]),
    );
    return readPreferences(Object.fromEntries(entries));
  },
  savePreference<K extends keyof FinancePreferences>(
    field: K,
    value: FinancePreferences[K],
  ): Promise<void> {
    const saved = preferenceWrites.then(async () =>
      (await financeSettings()).setValue(preferenceKeys[field], value),
    );
    preferenceWrites = saved.catch(() => undefined);
    return saved;
  },
  startRuntime(): () => void {
    if (!isTauri()) return () => undefined;
    const unsubscribe = source.onCompleted((event, mode) => {
      void alerts.complete(event, mode).catch(reportError);
    });
    void refreshToken().catch(reportError);
    void source.connect().catch(reportError);
    const stop = scheduleFinanceStartupUpdate(() => void requestUpdate());
    return () => {
      stop();
      unsubscribe();
    };
  },
  requestUpdate,
  async saveToken(value: string): Promise<void> {
    const token = await invoke<TokenStatus>("finance_token_set", { token: value });
    useFinanceState.setState({ token });
    await requestUpdate();
  },
  verify: () => invoke<void>("finance_verify"),
  async clearToken(): Promise<void> {
    await invoke("finance_token_clear");
    useFinanceState.setState({ token: { configured: false, tail: null }, confirmBackfill: false });
  },
  cancelUpdate: () => invoke<void>("finance_update_cancel"),
  openDirectory: () => invoke<void>("finance_open_directory"),
  dismissBackfill: () => useFinanceState.setState({ confirmBackfill: false }),
  async approveBackfill(): Promise<void> {
    try {
      const settings = await financeSettings();
      await settings.setValue(confirmedKey, true);
      useFinanceState.setState({ confirmBackfill: false });
      await requestUpdate();
    } catch (error) {
      reportError(error);
    }
  },
};

export function useFinanceUpdate() {
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}

export function useFinanceCache() {
  const revision = useFinanceUpdate().revision;
  const [view, setView] = useState<{ status?: FinanceStatus; error?: string }>({});
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    void source.getStatus().then(
      (status) => {
        if (live) setView({ status });
      },
      (error: unknown) => {
        if (live) setView({ error: financeDiagnostic(error).message });
      },
    );
    return () => {
      live = false;
    };
  }, [revision]);
  return view;
}

export function displayFinanceError(error: unknown): string {
  return financeDiagnostic(error).message;
}
