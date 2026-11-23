import { useEffect, useRef, useState } from "react";
import { Button, Dialog } from "@workbench/ui";
import type { ModuleManifest } from "@workbench/manifest";
import type { ModulePermission } from "./bridge";
import { moduleApi, type ModuleRecord } from "./module-api";
import { describeModuleError, type useModules } from "./use-modules";

const permissionNames: Record<string, string> = {
  storage: "读取和写入模块自己的存储",
  notifications: "显示软件内通知",
  "reminders:read": "读取提醒事项",
  "reminders:write": "创建或修改本模块的提醒事项",
  "calendar:read": "读取日程",
  "calendar:write": "创建或修改本模块的日程",
  "memos:read": "读取备忘录",
  "memos:write": "创建或修改本模块的备忘录",
  "dialog.open": "通过文件选择框取得路径授权",
  engine: "启动和管理本地引擎",
  "engine.exec_paths": "经确认后把已选路径作为可执行路径传给引擎",
};

function permissionName(permission: ModulePermission) {
  return permissionNames[permission] ?? permission;
}

type Approval =
  | { kind: "install"; ticket: string; manifest: ModuleManifest }
  | { kind: "uninstall"; record: ModuleRecord }
  | { kind: "revoke"; record: ModuleRecord; permission: ModulePermission };

function cleanupItems(manifest: ModuleManifest) {
  const cleanup = manifest.uninstall;
  return [
    "模块文件、本地引擎、缓存和模块 storage",
    "模块私有数据库及本模块写入的共享内容",
    "Windows 凭据管理器中的模块凭据",
    "模块设置、快捷键和 AI 动作注册",
    ...(cleanup?.credentials?.length
      ? [`声明凭据服务：${cleanup.credentials.map(({ service }) => service).join("、")}`]
      : []),
    ...(cleanup?.tables?.length ? [`私有数据表：${cleanup.tables.join("、")}`] : []),
    ...(cleanup?.settingsPrefixes?.length
      ? [`设置项前缀：${cleanup.settingsPrefixes.join("、")}`]
      : []),
  ];
}

export function ModuleManager({
  catalog,
  generalHidden,
  onGeneralVisibility,
}: {
  catalog: ReturnType<typeof useModules>;
  generalHidden: boolean;
  onGeneralVisibility: (hidden: boolean) => Promise<void>;
}) {
  const [approval, setApproval] = useState<Approval | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const stagedTicket = useRef<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const ticket = stagedTicket.current;
      stagedTicket.current = null;
      if (ticket) void moduleApi.discard(ticket).catch(() => undefined);
    };
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } catch (error) {
      setProblem(describeModuleError(error, "操作失败，请重试"));
    } finally {
      setBusy(false);
    }
  }
  function cancelApproval() {
    if (busy || !approval) return;
    const requested = approval;
    setApproval(null);
    if (requested.kind === "install") {
      stagedTicket.current = null;
      void run(() => moduleApi.discard(requested.ticket));
    }
  }
  function submitApproval() {
    if (busy || !approval) return;
    const requested = approval;
    setApproval(null);
    if (requested.kind === "install") stagedTicket.current = null;
    void run(async () => {
      if (requested.kind === "install") {
        try {
          await moduleApi.install(requested.ticket);
        } finally {
          await moduleApi.discard(requested.ticket).catch(() => undefined);
          await catalog.refresh().catch(() => undefined);
        }
      } else if (requested.kind === "uninstall") {
        try {
          await moduleApi.uninstall(requested.record.manifest.id);
        } finally {
          await catalog.refresh().catch(() => undefined);
        }
      } else {
        try {
          await moduleApi.revoke(requested.record.manifest.id, requested.permission);
        } finally {
          await catalog.refresh().catch(() => undefined);
        }
      }
    });
  }
  const manifest = approval?.kind === "install" ? approval.manifest : approval?.record.manifest;
  return (
    <section className="settings-section" aria-labelledby="module-management-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="module-management-title">模块管理</h2>
        <Button
          size="sm"
          disabled={busy || catalog.loading}
          onClick={() =>
            void run(async () => {
              const preview = await moduleApi.preview();
              if (!preview) return;
              if (!mounted.current) {
                await moduleApi.discard(preview.ticket);
                return;
              }
              stagedTicket.current = preview.ticket;
              setApproval({ kind: "install", ...preview });
            })
          }
        >
          安装本地 .wbpkg
        </Button>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border py-3">
        <div>
          <h3 className="font-medium">综合工作台</h3>
          <p>核心功能 · {generalHidden ? "入口已隐藏" : "入口已显示"}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void run(() => onGeneralVisibility(!generalHidden))}
        >
          {generalHidden ? "显示入口" : "隐藏入口"}
        </Button>
      </div>
      {catalog.loading && <p role="status">正在读取模块…</p>}
      {!catalog.loading && !catalog.error && !catalog.modules.length && <p>还未安装模块。</p>}
      {catalog.modules.map((record) => (
        <article key={record.manifest.id} className="space-y-2 border-t border-border py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="break-all font-medium">{record.manifest.name}</h3>
              <p className="break-all">
                {record.manifest.id} · {record.manifest.version}
              </p>
              {record.manifest.engine && <p className="font-semibold">完全信任 · 本地引擎</p>}
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setApproval({ kind: "uninstall", record })}
            >
              卸载
            </Button>
          </div>
          {record.manifest.permissions.length > 0 && (
            <ul className="space-y-1">
              {record.manifest.permissions.map((permission) => (
                <li
                  key={permission}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span>{permissionName(permission)}</span>
                  {record.grants.includes(permission) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      aria-label={`撤销：${permissionName(permission)}`}
                      onClick={() => setApproval({ kind: "revoke", record, permission })}
                    >
                      撤销
                    </Button>
                  ) : (
                    <span className="text-muted-foreground">已撤销</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
      {catalog.pending.map((id) => (
        <div
          key={id}
          className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-3"
        >
          <p>清理待完成：{id}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                try {
                  await moduleApi.uninstall(id);
                } finally {
                  await catalog.refresh().catch(() => undefined);
                }
              })
            }
          >
            继续清理
          </Button>
        </div>
      ))}
      {(problem || catalog.error) && (
        <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-destructive">{problem ?? catalog.error}</span>
          {catalog.error && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run(catalog.refresh)}
            >
              刷新列表
            </Button>
          )}
        </div>
      )}
      <Dialog
        className="max-h-[85dvh] overflow-y-auto"
        open={approval !== null}
        onOpenChange={(open) => {
          if (!open) cancelApproval();
        }}
        title={
          approval?.kind === "install"
            ? "确认安装模块"
            : approval?.kind === "revoke"
              ? "确认撤销权限"
              : "确认彻底卸载模块"
        }
        description={manifest ? `${manifest.name} · ${manifest.id} · ${manifest.version}` : ""}
        footer={
          <>
            <Button variant="outline" autoFocus disabled={busy} onClick={cancelApproval}>
              取消
            </Button>
            <Button disabled={busy} onClick={submitApproval}>
              {approval?.kind === "install"
                ? "同意并安装"
                : approval?.kind === "revoke"
                  ? "撤销权限"
                  : "彻底卸载"}
            </Button>
          </>
        }
      >
        {approval?.kind === "install" && (
          <>
            {approval.manifest.engine && (
              <div className="mt-4 rounded-lg border border-destructive p-3 text-sm" role="alert">
                <strong className="text-destructive">完全信任：此模块包含本地引擎</strong>
                <div>
                  引擎以当前 Windows 用户身份运行，可以访问本机文件和其他资源。仅安装你信任的模块。
                </div>
                <div className="mt-2 break-all font-mono text-xs">
                  SHA-256 {approval.manifest.engine.sha256}
                </div>
              </div>
            )}
            <ul className="mt-4 list-disc space-y-1 pl-5 text-sm">
              {approval.manifest.permissions.length ? (
                approval.manifest.permissions.map((permission) => (
                  <li key={permission}>{permissionName(permission)}</li>
                ))
              ) : (
                <li>没有额外权限</li>
              )}
            </ul>
          </>
        )}
        {approval?.kind === "uninstall" && (
          <>
            <ul className="mt-4 list-disc space-y-1 pl-5 text-sm">
              {cleanupItems(approval.record.manifest).map((item) => (
                <li key={item} className="break-all">
                  {item}
                </li>
              ))}
            </ul>
            <div className="mt-3 text-sm font-semibold text-destructive">
              删除后无法恢复这些内容。
            </div>
          </>
        )}
        {approval?.kind === "revoke" && (
          <div className="mt-4 text-sm">{permissionName(approval.permission)}</div>
        )}
      </Dialog>
    </section>
  );
}
