import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = fileURLToPath(new URL("../", import.meta.url));
const staging = mkdtempSync(join(moduleRoot, ".package-"));
const zipPath = join(staging, "pomodoro.zip");
const output = "sample-pomodoro.wbpkg";
const script = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.IO.Compression.FileSystem",
  "[IO.Compression.ZipFile]::CreateFromDirectory((Join-Path (Get-Location) 'dist'), $env:WORKBENCH_SAMPLE_ZIP)",
].join("\n");
try {
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: moduleRoot,
    env: { ...process.env, WORKBENCH_SAMPLE_ZIP: zipPath },
    stdio: "inherit",
    windowsHide: true,
  });
  renameSync(zipPath, join(moduleRoot, output));
  console.log(`已打包 ${output}`);
} finally {
  rmSync(zipPath, { force: true });
  rmdirSync(staging);
}
