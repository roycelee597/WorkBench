import { useCallback, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { moduleApi, type ModuleRecord } from "./module-api";

export function useModules() {
  const [modules, setModules] = useState<ModuleRecord[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [officialErrors, setOfficialErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await moduleApi.readList();
      setModules(next.modules);
      setPending(next.pending);
      setOfficialErrors(next.officialErrors ?? {});
      setError(null);
    } catch (error) {
      setError(describeModuleError(error, "未能读取已安装模块"));
      throw error;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let current = true;
    void moduleApi.start().then(
      (result) => {
        if (!current) return;
        setModules(result.modules);
        setPending(result.pending);
        setOfficialErrors(result.officialErrors ?? {});
        setLoading(false);
      },
      (error: unknown) => {
        if (!current) return;
        setError(describeModuleError(error, "未能读取已安装模块"));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, []);
  return { modules, pending, officialErrors, refresh, loading, error };
}

export function describeModuleError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message ? message.slice(0, 300) : fallback;
}
