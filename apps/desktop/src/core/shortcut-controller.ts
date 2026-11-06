export const DEFAULT_SHORTCUT = "Ctrl+Alt+N";
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
    !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(key) ||
    !modifiers.length ||
    !modifiers.every((part) => ["CTRL", "ALT", "SHIFT"].includes(part)) ||
    new Set(modifiers).size !== modifiers.length ||
    !modifiers.some((part) => part === "CTRL" || part === "ALT") ||
    (key === "F4" && modifiers.length === 1 && modifiers[0] === "ALT")
  )
    throw new Error("请使用 Ctrl / Alt / Shift 加字母、数字或 F1–F12，例如 Ctrl+Alt+N");
  return [
    ...["CTRL", "ALT", "SHIFT"]
      .filter((part) => modifiers.includes(part))
      .map((part) => ({ CTRL: "Ctrl", ALT: "Alt", SHIFT: "Shift" })[part]),
    key,
  ].join("+");
}
export interface ShortcutPort {
  register: (shortcut: string, pressed: () => void) => Promise<void>;
  unregister: (shortcut: string) => Promise<void>;
  load: () => Promise<string>;
  persist: (shortcut: string) => Promise<void>;
  open: () => Promise<void>;
}
export class ShortcutController {
  private status: ShortcutStatus = { configured: DEFAULT_SHORTCUT, active: null, error: null };
  private initialization: Promise<void> | undefined;
  private sequence = Promise.resolve();
  constructor(
    private readonly port: ShortcutPort,
    private readonly changed: (status: ShortcutStatus) => void = () => undefined,
  ) {}
  getStatus() {
    return { ...this.status };
  }
  private update(patch: Partial<ShortcutStatus>) {
    this.status = { ...this.status, ...patch };
    this.changed(this.getStatus());
  }
  private pressed = () => {
    void this.port.open().catch(() => this.update({ error: "未能打开快速新建窗口，请重试。" }));
  };
  start() {
    this.initialization ??= (async () => {
      try {
        const configured = normalizeShortcut(await this.port.load());
        this.update({ configured });
        await this.port.register(configured, this.pressed);
        this.update({ active: configured, error: null });
      } catch {
        this.update({
          error: `快捷键 ${this.status.configured} 注册失败，可能已被其他程序占用。请在设置中更换或重试。`,
        });
      }
    })();
    return this.initialization;
  }
  async configure(input: string) {
    const next = normalizeShortcut(input);
    const operation = this.sequence.then(async () => {
      await this.start();
      const previous = this.status.active;
      if (next === previous) {
        this.update({ error: null });
        return;
      }
      let registered = false;
      let persisted = false;
      try {
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
        const message = rollbackFailed
          ? "快捷键回滚未完成，请重启应用后重新设置。"
          : registered
            ? "快捷键设置失败，已保留原快捷键，请重试。"
            : `快捷键 ${next} 注册失败，可能与其他程序冲突，请换一个组合。`;
        this.update({ error: message });
        throw new Error(message, { cause: error });
      }
    });
    this.sequence = operation.catch(() => undefined);
    await operation;
    return this.getStatus();
  }
  async stop() {
    await this.initialization;
    await this.sequence;
    if (this.status.active) await this.port.unregister(this.status.active);
    this.update({ active: null });
  }
}
