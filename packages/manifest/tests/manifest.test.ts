import { describe, expect, it } from "vitest";
import { CORE_MODULE_ID, validateManifest } from "../src/index";

const basic = {
  id: "com.royce.pomodoro",
  name: "番茄钟",
  version: "1.0.0",
  minHostVersion: "0.1.0",
  entry: "ui/index.html",
  permissions: ["storage", "notifications"],
};
const engine = {
  path: "engine/worker.exe",
  sha256: "a1".repeat(32),
  concurrency: 2,
};

describe("模块 manifest", () => {
  it("接受静态模块和带引擎的严格语义版本", () => {
    expect(validateManifest(basic)).toEqual(basic);
    const trusted = {
      ...basic,
      version: "1.2.3-beta.2+windows.01",
      permissions: ["engine", "dialog.open", "engine.exec_paths"],
      engine,
      uninstall: {
        credentials: [{ service: "fake", account: "synthetic" }],
        tables: ["module_metrics"],
        settingsPrefixes: ["feature."],
      },
    };
    expect(validateManifest(trusted)).toEqual(trusted);
  });

  it.each([
    { id: "com.example" },
    { id: "com.-example.plugin" },
    { id: "com.example.plugin-" },
    { id: "com.Example.plugin" },
    { id: "con.example.plugin" },
    { id: CORE_MODULE_ID },
    { version: "01.0.0" },
    { version: "1.0" },
    { version: "1.0.0-beta.01" },
    { version: "18446744073709551616.0.0" },
    { version: "1000000000.0.0" },
    { minHostVersion: ">=0.1.0" },
    { permissions: ["storage", "storage"] },
    { permissions: ["net"] },
    { permissions: ["engine"] },
    { permissions: ["engine.exec_paths"], engine },
    { engine: { ...engine, sha256: "z".repeat(64) } },
    { engine: { ...engine, concurrency: 0 } },
    { engine: { ...engine, concurrency: 9 } },
    { engine: { ...engine, path: "engine/start.bat" } },
    { engine: { ...engine, path: "C:/worker.exe" } },
    { engine: { ...engine, startup: true } },
    { uninstall: { credentials: [{ service: "../test", account: "synthetic" }] } },
    { uninstall: { settingsPrefixes: ["*"] } },
    { uninstall: { tables: ["sqlite_master"] } },
    { uninstall: { tables: ["tasks", "TASKS"] } },
    { uninstall: { tables: ["tasks;select"] } },
    { home: "unexpected" },
    { homepage: "file:///a" },
    { description: " " },
  ])("拒绝无效声明 %j", (override) => {
    expect(() => validateManifest({ ...basic, ...override })).toThrow();
  });

  it.each([
    "../index.html",
    "ui/../index.html",
    "ui/./index.html",
    "ui//index.html",
    "ui\\index.html",
    "ui/%2e%2e/index.html",
    "/index.html",
    "C:/index.html",
    "ui/aux.html",
    "ui/COM9/index.html",
    "ui./index.html",
    "ui/index.html?other",
    "index.js",
  ])("拒绝不安全或无效的入口 %s", (entry) => {
    expect(() => validateManifest({ ...basic, entry })).toThrow();
  });
});
