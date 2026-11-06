import { invoke } from "@tauri-apps/api/core";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { generalApi, workspace } from "@workbench/general";
import { ShortcutController } from "../core/shortcut-controller";

export const shortcutController = new ShortcutController(
  {
    register: (shortcut, pressed) =>
      register(shortcut, (event) => {
        if (event.state === "Pressed") pressed();
      }),
    unregister,
    load: () => generalApi.getStoredShortcut(),
    persist: (value) => generalApi.setStoredShortcut(value),
    open: () => invoke("open_quick_create"),
  },
  (status) => workspace.useWorkspace.setState({ shortcutError: status.error }),
);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    void shortcutController.stop().catch(console.error);
  });
