export function createChangeSignal() {
  const listeners = new Set<(tables: ReadonlySet<string>) => void>();
  return {
    subscribe(listener: (tables: ReadonlySet<string>) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(tables: ReadonlySet<string> = new Set()) {
      for (const listener of listeners) {
        try {
          listener(tables);
        } catch (error) {
          console.error("更新监听失败", error);
        }
      }
    },
  };
}
