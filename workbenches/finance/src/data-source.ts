import type { FinancePoint } from "../../../apps/desktop/src/core/finance/finance-reader";

export function isAkshare(point: FinancePoint | undefined): boolean {
  if (!point || point.value === null || !point.extra_json) return false;
  try {
    const metadata: unknown = JSON.parse(point.extra_json);
    return (
      metadata !== null &&
      typeof metadata === "object" &&
      "source" in metadata &&
      metadata.source === "akshare"
    );
  } catch {
    return false;
  }
}

export function sourceLabel(point: FinancePoint | undefined): string {
  if (!isAkshare(point)) return "";
  return point && "month" in point ? "月均含 AKShare 备用源" : "AKShare 备用源";
}
