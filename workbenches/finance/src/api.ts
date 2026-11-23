import { useEffect, useState } from "react";
import { create } from "zustand";
import {
  createWorkbenchSdk,
  type FinanceCacheStatus,
  type FinanceModuleSnapshot,
  type FinancePreferences,
  type FinancePreferenceWrite,
  type FinanceUpdateMode,
} from "@workbench/sdk";

// 测试连接由宿主限制为约 60 秒，SDK 给它留出返回超时消息的时间。
const wb = createWorkbenchSdk({ timeoutMs: 70_000 });
export const useFinanceState = create<FinanceModuleSnapshot>(() => ({
  token: null,
  confirmBackfill: false,
  error: null,
  update: { status: "idle", revision: 0 },
}));

function reportError(error: unknown) {
  useFinanceState.setState({ error: displayFinanceError(error) });
}

export function connectFinanceModule() {
  let active = true;
  let receivedUpdate = false;
  const unsubscribe = wb.finance.onChange((snapshot) => {
    receivedUpdate = true;
    useFinanceState.setState(snapshot);
  });
  const applyTheme = (theme: string) =>
    document.documentElement.classList.toggle("dark", theme === "dark");
  let receivedTheme = false;
  const stopTheme = wb.app.onThemeChange((theme) => {
    receivedTheme = true;
    applyTheme(theme);
  });
  void wb.app
    .getTheme()
    .then((theme) => {
      if (active && !receivedTheme) applyTheme(theme);
    })
    .catch(() => undefined);
  void wb.finance.snapshot().then(
    (snapshot) => {
      if (active && !receivedUpdate) useFinanceState.setState(snapshot);
    },
    (error: unknown) => {
      if (active) reportError(error);
    },
  );
  return () => {
    active = false;
    unsubscribe();
    stopTheme();
    wb.dispose();
  };
}

export const financeApi = {
  listIndicators: wb.finance.listIndicators,
  getRecent: wb.finance.getRecent,
  getSeries: wb.finance.getSeries,
  getOverlay: wb.finance.getOverlay,
  loadThresholds: wb.finance.loadThresholds,
  saveThreshold: wb.finance.saveThreshold,
  deleteThreshold: wb.finance.deleteThreshold,
  loadPreferences: wb.finance.loadPreferences,
  async savePreference<K extends keyof FinancePreferences>(field: K, value: FinancePreferences[K]) {
    await wb.finance.savePreference({ field, value } as FinancePreferenceWrite);
  },
  loadFallback: wb.finance.loadFallback,
  async saveFallback(enabled: boolean) {
    await wb.finance.saveFallback(enabled);
  },
  async requestUpdate(mode: FinanceUpdateMode = "auto") {
    await wb.finance.requestUpdate(mode).catch(reportError);
  },
  async cancelUpdate() {
    await wb.finance.cancelUpdate();
  },
  async saveToken(token: string) {
    await wb.finance.saveToken(token);
  },
  async clearToken() {
    await wb.finance.clearToken();
  },
  async verify() {
    await wb.finance.verify();
  },
  async openDirectory() {
    await wb.finance.openDirectory();
  },
  dismissBackfill() {
    void wb.finance.dismissBackfill().catch(reportError);
  },
  async approveBackfill() {
    await wb.finance.approveBackfill().catch(reportError);
  },
};

export function useFinanceUpdate() {
  return useFinanceState((state) => state.update);
}

export function useFinanceCache() {
  const revision = useFinanceUpdate().revision;
  const [view, setView] = useState<{ status?: FinanceCacheStatus; error?: string }>({});
  useEffect(() => {
    let live = true;
    void wb.finance.cacheStatus().then(
      (status) => {
        if (live) setView({ status });
      },
      (error: unknown) => {
        if (live) setView({ error: displayFinanceError(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [revision]);
  return view;
}

export function displayFinanceError(error: unknown): string {
  return error instanceof Error ? error.message : "金融操作未完成，请重试";
}
