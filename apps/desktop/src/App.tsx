import { AppShell } from "./shell/AppShell";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { QuickCreateWindow } from "./shell/QuickCreateWindow";
import "./styles.css";
export default function App() {
  return isTauri() && getCurrentWindow().label === "quick-create" ? (
    <QuickCreateWindow />
  ) : (
    <AppShell />
  );
}
