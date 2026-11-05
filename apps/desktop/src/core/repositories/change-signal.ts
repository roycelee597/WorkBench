export function createChangeSignal() {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit() {
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          console.error("更新监听失败", error);
        }
      }
    },
  };
}
