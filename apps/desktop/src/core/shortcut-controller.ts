export const DEFAULT_SHORTCUT = "Ctrl+Alt+N";
export const DEFAULT_AI_SHORTCUT = "Ctrl+Alt+Space";
export interface ShortcutStatus {
  configured: string;
  active: string | null;
  error: string | null;
}
export function normalizeShortcut(input: string): string {
  const parts = input
    .trim()
    .split("+")
    .map((part) => part.trim().toUpperCase());
  const key = parts.pop();
  const modifiers = parts.map((part) => (part === "CONTROL" ? "CTRL" : part));
  if (
    !key ||
    !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|SPACE)$/.test(key) ||
    !modifiers.length ||
    !modifiers.every((part) => ["CTRL", "ALT", "SHIFT"].includes(part)) ||
    new Set(modifiers).size !== modifiers.length ||
    !modifiers.some((part) => part === "CTRL" || part === "ALT") ||
    (key === "F4" && modifiers.length === 1 && modifiers[0] === "ALT") ||
    (key === "SPACE" &&
      !(modifiers.includes("CTRL") && (modifiers.includes("ALT") || modifiers.includes("SHIFT"))))
  )
    throw new Error(
      "请使用 Ctrl / Alt / Shift 加字母、数字或 F1–F12；Space 必须带 Ctrl+Alt 或 Ctrl+Shift",
    );
  return [
    ...["CTRL", "ALT", "SHIFT"]
      .filter((part) => modifiers.includes(part))
      .map((part) => ({ CTRL: "Ctrl", ALT: "Alt", SHIFT: "Shift" })[part]),
    key === "SPACE" ? "Space" : key,
  ].join("+");
}
export interface ShortcutPort {
  register: (shortcut: string, pressed: () => void) => Promise<void>;
  unregister: (shortcut: string) => Promise<void>;
  load: () => Promise<string>;
  persist: (shortcut: string) => Promise<void>;
  open: () => Promise<void>;
}

class ShortcutConflictError extends Error {}

// 两个控制器共用队列，注册、保存和回滚期间都不会被另一方的改键穿插。
export class ShortcutCoordinator {
  private sequence = Promise.resolve();
  private readonly members = new Map<ShortcutController, string>();
  add(controller: ShortcutController, label: string) {
    this.members.set(controller, label);
  }
  assertAvailable(owner: ShortcutController, shortcut: string) {
    for (const [controller, label] of this.members)
      if (controller !== owner && controller.getStatus().active === shortcut)
        throw new ShortcutConflictError(`与${label}快捷键冲突，请更换组合。`);
  }
  run<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.sequence.then(operation);
    this.sequence = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}

interface ShortcutOptions {
  defaultShortcut?: string;
  openError?: string;
  label?: string;
  coordinator?: ShortcutCoordinator;
}
export class ShortcutController {
  private status: ShortcutStatus;
  private initialization: Promise<void> | undefined;
  private initialized = false;
  private readonly coordinator: ShortcutCoordinator;
  constructor(
    private readonly port: ShortcutPort,
    private readonly changed: (status: ShortcutStatus) => void = () => undefined,
    private readonly options: ShortcutOptions = {},
  ) {
    this.status = {
      configured: options.defaultShortcut ?? DEFAULT_SHORTCUT,
      active: null,
      error: null,
    };
    this.coordinator = options.coordinator ?? new ShortcutCoordinator();
    this.coordinator.add(this, options.label ?? "快速新建");
  }
  getStatus() {
    return { ...this.status };
  }
  private update(patch: Partial<ShortcutStatus>) {
    this.status = { ...this.status, ...patch };
    this.changed(this.getStatus());
  }
  private pressed = () => {
    const failed = () =>
      this.update({ error: this.options.openError ?? "未能打开快速新建窗口，请重试。" });
    try {
      void this.port.open().catch(failed);
    } catch {
      failed();
    }
  };
  private async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const configured = normalizeShortcut(await this.port.load());
      this.update({ configured });
      this.coordinator.assertAvailable(this, configured);
      await this.port.register(configured, this.pressed);
      this.update({ active: configured, error: null });
    } catch (error) {
      this.update({
        error:
          error instanceof ShortcutConflictError
            ? error.message
            : `快捷键 ${this.status.configured} 注册失败，可能已被其他程序占用。请在设置中更换或重试。`,
      });
    }
  }
  start() {
    this.initialization ??= this.coordinator.run(() => this.initialize());
    return this.initialization;
  }
  async configure(input: string) {
    const next = normalizeShortcut(input);
    return this.coordinator.run(async () => {
      await this.initialize();
      const previous = this.status.active;
      if (next === previous) {
        this.update({ error: null });
        return this.getStatus();
      }
      let registered = false;
      let persisted = false;
      try {
        this.coordinator.assertAvailable(this, next);
        await this.port.register(next, this.pressed);
        registered = true;
        await this.port.persist(next);
        persisted = true;
        if (previous) await this.port.unregister(previous);
        this.update({ configured: next, active: next, error: null });
      } catch (error) {
        let rollbackFailed = false;
        if (registered)
          await this.port.unregister(next).catch(() => {
            rollbackFailed = true;
          });
        if (persisted)
          await this.port.persist(this.status.configured).catch(() => {
            rollbackFailed = true;
          });
        const message =
          error instanceof ShortcutConflictError
            ? error.message
            : rollbackFailed
              ? "快捷键回滚未完成，请重启应用后重新设置。"
              : registered
                ? "快捷键设置失败，已保留原快捷键，请重试。"
                : `快捷键 ${next} 注册失败，可能与其他程序冲突，请换一个组合。`;
        this.update({ error: message });
        throw new Error(message, { cause: error });
      }
      return this.getStatus();
    });
  }
  async stop() {
    await this.coordinator.run(async () => {
      if (this.status.active) await this.port.unregister(this.status.active);
      this.update({ active: null });
      this.initialized = false;
      this.initialization = undefined;
    });
  }
}
