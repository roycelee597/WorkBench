let allowed = true;
const listeners = new Set<(value: boolean) => void>();

export const aiReadPolicy = {
  isAllowed: () => allowed,
  subscribe(listener: (value: boolean) => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function publishReadPolicy(value: boolean) {
  if (value === allowed) return;
  allowed = value;
  for (const listener of listeners) listener(value);
}
