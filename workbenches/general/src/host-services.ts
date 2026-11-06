import type { ShortcutStatus } from "../../../apps/desktop/src/core/shortcut-controller";
export interface HostServices {
  getAutostart: () => Promise<boolean>;
  setAutostart: (enabled: boolean) => Promise<void>;
  getShortcut?: () => Promise<ShortcutStatus>;
  setShortcut?: (value: string) => Promise<ShortcutStatus>;
}
let services: HostServices = {
  getAutostart: async () => false,
  setAutostart: async () => {
    throw new Error("请在桌面应用中设置开机自启");
  },
};
let pendingOffer = false;
const offerListeners = new Set<() => void>();
export function configureHostServices(value: HostServices) {
  services = value;
}
export const hostServices = {
  getAutostart: () => services.getAutostart(),
  setAutostart: (enabled: boolean) => services.setAutostart(enabled),
  getShortcut: async () => {
    if (!services.getShortcut) throw new Error("请在桌面应用中设置全局快捷键");
    return services.getShortcut();
  },
  setShortcut: async (value: string) => {
    if (!services.setShortcut) throw new Error("请在桌面应用中设置全局快捷键");
    return services.setShortcut(value);
  },
};
export function offerAutostart() {
  pendingOffer = true;
  for (const listener of offerListeners) {
    pendingOffer = false;
    listener();
  }
}
export function onAutostartOffer(listener: () => void) {
  offerListeners.add(listener);
  if (pendingOffer) {
    pendingOffer = false;
    listener();
  }
  return () => {
    offerListeners.delete(listener);
  };
}
