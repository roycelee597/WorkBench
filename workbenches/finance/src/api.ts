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

type TokenStatus = { configured: boolean; tail: string | null };
const source = new LocalSidecarSource();
const confirmedKey = "finance.initial_backfill_confirmed";

async function financeSettings() {
  const { initializeDataLayer } =
    await import("../../../apps/desktop/src/core/repositories/initialize");
  return (await initializeDataLayer()).settings;
}

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
    await source.requestUpdate(mode);
  } catch (error) {
    reportError(error);
  }
}

export const financeApi = {
  startRuntime(): () => void {
    if (!isTauri()) return () => undefined;
    void refreshToken().catch(reportError);
    void source.connect().catch(reportError);
    return scheduleFinanceStartupUpdate(() => void requestUpdate());
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
