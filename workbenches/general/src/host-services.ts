export interface HostServices {
  getAutostart: () => Promise<boolean>;
  setAutostart: (enabled: boolean) => Promise<void>;
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
