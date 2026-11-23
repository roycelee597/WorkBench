import { z } from "zod";

export const CORE_MODULE_ID = "com.royce.workbench.general";
export const FINANCE_MODULE_ID = "com.royce.workbench.finance";
export const MODULE_PERMISSIONS = [
  "storage",
  "notifications",
  "reminders:read",
  "reminders:write",
  "calendar:read",
  "calendar:write",
  "memos:read",
  "memos:write",
  "dialog.open",
  "engine",
  "engine.exec_paths",
  "finance",
] as const;
export const modulePermissionSchema = z.enum(MODULE_PERMISSIONS);
export type ModulePermission = z.infer<typeof modulePermissionSchema>;

const dnsLabel = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const reservedDevice = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu;
export const moduleIdSchema = z
  .string()
  .max(120)
  .refine((id) => {
    const labels = id.split(".");
    return (
      labels.length >= 3 &&
      labels.every((label) => dnsLabel.test(label)) &&
      !reservedDevice.test(id)
    );
  }, "模块 ID 必须使用至少三段小写反向域名");

const versionNumber = "(?:0|[1-9][0-9]{0,8})";
const pre = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const build = "[0-9A-Za-z-]+";
const semver = new RegExp(
  `^${versionNumber}\\.${versionNumber}\\.${versionNumber}(?:-${pre}(?:\\.${pre})*)?(?:\\+${build}(?:\\.${build})*)?$`,
);
const versionSchema = z.string().max(64).regex(semver, "必须使用有效的 SemVer 版本号");

const fileSegment = /^[A-Za-z0-9_-](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_-])?$/;
export const modulePathSchema = z
  .string()
  .max(240)
  .refine(
    (path) =>
      path
        .split("/")
        .every((segment) => fileSegment.test(segment) && !reservedDevice.test(segment)),
    "包内路径必须是可移植的相对路径",
  );

const printableName = (length: number) =>
  z
    .string()
    .min(1)
    .max(length)
    .refine((name) => name.trim().length > 0, "名称不能为空");
const webUrl = z.url({ protocol: /^https?$/ }).max(2048);
const resourceName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/u);
const tableName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u)
  .refine((name) => !name.toLowerCase().startsWith("sqlite_"), "不能声明 SQLite 内部表");

function unique<T>(values: T[], key: (value: T) => string) {
  return new Set(values.map(key)).size === values.length;
}

export const manifestSchema = z
  .strictObject({
    id: moduleIdSchema.refine((id) => id !== CORE_MODULE_ID, "核心工作台不能由本地包安装"),
    name: printableName(120),
    version: versionSchema,
    entry: modulePathSchema.refine((path) => /\.html$/iu.test(path), "入口必须是 HTML 文件"),
    minHostVersion: versionSchema,
    permissions: z
      .array(modulePermissionSchema)
      .max(MODULE_PERMISSIONS.length)
      .refine((values) => unique(values, (value) => value), "权限不能重复声明"),
    description: printableName(1000).optional(),
    author: z.strictObject({ name: printableName(120), url: webUrl.optional() }).optional(),
    icon: modulePathSchema.optional(),
    license: printableName(80).optional(),
    homepage: webUrl.optional(),
    engine: z
      .strictObject({
        path: modulePathSchema.refine(
          (path) => /\.exe$/iu.test(path),
          "引擎必须是 Windows .exe 文件",
        ),
        sha256: z.string().regex(/^[a-f0-9]{64}$/iu, "引擎摘要必须是 64 位十六进制 SHA-256"),
        concurrency: z.number().int().min(1).max(8),
      })
      .optional(),
    uninstall: z
      .strictObject({
        credentials: z
          .array(z.strictObject({ service: resourceName, account: resourceName }))
          .max(64)
          .refine(
            (values) =>
              unique(
                values,
                ({ service, account }) => `${service.toLowerCase()}:${account.toLowerCase()}`,
              ),
            "凭据声明不能重复",
          )
          .optional(),
        tables: z
          .array(tableName)
          .max(64)
          .refine((values) => unique(values, (name) => name.toLowerCase()), "数据表声明不能重复")
          .optional(),
        settingsPrefixes: z
          .array(resourceName)
          .max(64)
          .refine((values) => unique(values, (value) => value), "设置前缀不能重复声明")
          .optional(),
      })
      .optional(),
  })
  .superRefine((manifest, context) => {
    const permissions = new Set(manifest.permissions);
    if (permissions.has("finance") && manifest.id !== FINANCE_MODULE_ID)
      context.addIssue({
        code: "custom",
        path: ["permissions"],
        message: "finance 权限仅供官方金融模块使用",
      });
    if (permissions.has("engine") && !manifest.engine)
      context.addIssue({
        code: "custom",
        path: ["engine"],
        message: "engine 权限要求声明引擎文件",
      });
    if (
      permissions.has("engine.exec_paths") &&
      (!permissions.has("engine") || !permissions.has("dialog.open"))
    )
      context.addIssue({
        code: "custom",
        path: ["permissions"],
        message: "执行路径权限要求 engine 和 dialog.open",
      });
  });

export type ModuleManifest = z.infer<typeof manifestSchema>;

export function validateManifest(input: unknown): ModuleManifest {
  return manifestSchema.parse(input);
}
