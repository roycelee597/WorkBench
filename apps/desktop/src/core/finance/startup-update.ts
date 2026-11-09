export function scheduleFinanceStartupUpdate(run: () => void): () => void {
  const timer = setTimeout(run, 10_000);
  return () => clearTimeout(timer);
}
