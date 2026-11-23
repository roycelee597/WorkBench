import { invoke } from "@tauri-apps/api/core";
import { validateManifest, type ModuleManifest } from "@workbench/manifest";
import type { JsonValue } from "../core/repositories/models";
import { BridgeError, type ModulePermission } from "./bridge";

export type ModuleRecord = {
  manifest: ModuleManifest;
  grants: ModulePermission[];
  url: string;
};

type ModuleList = { modules: ModuleRecord[]; pending: string[] };
type ModulePreview = { ticket: string; manifest: ModuleManifest };
const operations = new Map<string, Promise<unknown>>();
const generalVisibilityKey = "core.general.hidden";

export const generalModuleId = "com.royce.workbench.general";

export async function moduleDataLayer() {
  const { initializeDataLayer } = await import("../core/repositories/initialize");
  return initializeDataLayer();
}

export function sequenceModuleWrite<T>(id: string, run: () => Promise<T>): Promise<T> {
  const queued = (operations.get(id) ?? Promise.resolve()).catch(() => undefined).then(run);
  operations.set(id, queued);
  return queued.finally(() => {
    if (operations.get(id) === queued) operations.delete(id);
  });
}

function validatedModule(row: ModuleRecord): ModuleRecord {
  const manifest = validateManifest(row.manifest);
  const url = new URL(row.url);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !(url.origin === "http://wbpkg.localhost" || url.protocol === "wbpkg:")
  )
    throw new Error("模块入口无效");
  return {
    ...row,
    manifest,
    grants: row.grants.filter((permission) => manifest.permissions.includes(permission)),
  };
}

async function readList(): Promise<ModuleList> {
  const result = await invoke<ModuleList>("module_list");
  return { modules: result.modules.map(validatedModule), pending: result.pending };
}

async function uninstall(id: string) {
  if (id === generalModuleId || id === "general") throw new Error("综合工作台不可卸载");
  await sequenceModuleWrite(id, async () => {
    await invoke("uninstall_module", { id });
    await (await moduleDataLayer()).moduleCleanup.purgeSharedData(id);
    await invoke("module_finish_uninstall", { id });
  });
}

let startup: Promise<ModuleList> | undefined;
export const moduleApi = {
  readList,
  start() {
    startup ??= (async () => {
      const { pending } = await readList();
      await Promise.allSettled(pending.map(uninstall));
      return readList();
    })().finally(() => {
      startup = undefined;
    });
    return startup;
  },
  async preview() {
    const preview = await invoke<ModulePreview | null>("module_preview");
    if (!preview) return null;
    try {
      return { ...preview, manifest: validateManifest(preview.manifest) };
    } catch (error) {
      await invoke("module_discard", { ticket: preview.ticket });
      throw error;
    }
  },
  async discard(ticket: string) {
    await invoke("module_discard", { ticket });
  },
  async install(ticket: string) {
    return validatedModule(await invoke<ModuleRecord>("install_module", { ticket }));
  },
  uninstall,
  async revoke(id: string, permission: ModulePermission) {
    await sequenceModuleWrite(id, () => invoke("module_revoke", { id, permission }));
  },
  async isGeneralHidden() {
    return (await (await moduleDataLayer()).settings.getValue(generalVisibilityKey)) === true;
  },
  async setGeneralHidden(hidden: boolean) {
    await (await moduleDataLayer()).settings.setValue(generalVisibilityKey, hidden);
  },
  async readStorage(id: string) {
    return invoke<Record<string, JsonValue>>("module_storage_read", { id });
  },
  async writeStorage(id: string, key: string, remove: boolean, value?: JsonValue) {
    try {
      await invoke("module_storage_write", { id, key, value, remove });
    } catch (error) {
      if (String(error).includes("10 MiB"))
        throw new BridgeError("QUOTA_EXCEEDED", "模块存储超过 10 MiB 上限");
      throw error;
    }
  },
};
