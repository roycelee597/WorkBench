import type { ShortcutStatus } from "../../../apps/desktop/src/core/shortcut-controller";
import type { AiTarget } from "../../../apps/desktop/src/core/ai/action-types";

export interface AiHostServices {
  getShortcut: () => Promise<ShortcutStatus>;
  setShortcut: (value: string) => Promise<ShortcutStatus>;
  openTarget?: (target: AiTarget) => Promise<void>;
  openCreateForm?: (actionName: string, draft: unknown) => Promise<void>;
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

export const aiHostServices: Required<AiHostServices> = {
  getShortcut: () => services.getShortcut(),
  setShortcut: (value) => services.setShortcut(value),
  openTarget: async (target) => {
    if (!services.openTarget) throw new Error("请在桌面应用中查看已保存的内容");
    await services.openTarget(target);
  },
  openCreateForm: async (actionName, draft) => {
    if (!services.openCreateForm) throw new Error("请在桌面应用中打开新建表单");
    await services.openCreateForm(actionName, draft);
  },
};
