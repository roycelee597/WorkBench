import type { ShortcutStatus } from "../../../apps/desktop/src/core/shortcut-controller";

export interface AiHostServices {
  getShortcut: () => Promise<ShortcutStatus>;
  setShortcut: (value: string) => Promise<ShortcutStatus>;
}

let services: AiHostServices = {
  getShortcut: async () => {
    throw new Error("请在桌面应用中设置 AI 快捷键");
  },
  setShortcut: async () => {
    throw new Error("请在桌面应用中设置 AI 快捷键");
  },
};

export function configureAiHostServices(value: AiHostServices) {
  const previous = services;
  services = value;
  return () => {
    if (services === value) services = previous;
  };
}

export const aiHostServices: AiHostServices = {
  getShortcut: () => services.getShortcut(),
  setShortcut: (value) => services.setShortcut(value),
};
