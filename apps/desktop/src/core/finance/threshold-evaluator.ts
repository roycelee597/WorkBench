import type { AlertStateFields } from "../repositories/finance-alert-states";
import type { FinanceThreshold } from "../repositories/finance-thresholds";

export type ThresholdPoint = { trade_date: number; value: number };

export function outsideThreshold(
  value: number,
  threshold: Pick<FinanceThreshold, "direction" | "level">,
): boolean {
  return threshold.direction === "above" ? value > threshold.level : value < threshold.level;
}

export function evaluateThreshold(
  threshold: FinanceThreshold,
  previous: AlertStateFields | undefined,
  latest: ThresholdPoint | undefined,
  fresh: readonly ThresholdPoint[],
  reset = false,
):
  { next: AlertStateFields; crossing?: { firstDate: number; latest: ThresholdPoint } } | undefined {
  if (!threshold.enabled || !latest) return;
  const sameVersion = previous?.threshold_version === threshold.updated_at;
  if (!previous || !sameVersion || reset) {
    if (sameVersion && previous && latest.trade_date < previous.evaluated_through) return;
    return {
      next: {
        threshold_id: threshold.id,
        threshold_version: threshold.updated_at,
        breached: outsideThreshold(latest.value, threshold),
        evaluated_through: latest.trade_date,
        last_crossed_date: previous?.last_crossed_date ?? null,
        last_reminder_id: previous?.last_reminder_id ?? null,
      },
    };
  }

  const next = {
    threshold_id: previous.threshold_id,
    threshold_version: previous.threshold_version,
    breached: previous.breached,
    evaluated_through: previous.evaluated_through,
    last_crossed_date: previous.last_crossed_date,
    last_reminder_id: previous.last_reminder_id,
  };
  let firstDate: number | undefined;
  for (const { trade_date: date, value } of [...fresh].sort(
    (a, b) => a.trade_date - b.trade_date,
  )) {
    if (date <= next.evaluated_through || date > latest.trade_date) continue;
    next.evaluated_through = date;
    if (next.breached) {
      const { direction, level, hysteresis } = threshold;
      next.breached =
        direction === "above" ? value >= level - hysteresis : value <= level + hysteresis;
    } else if (outsideThreshold(value, threshold)) {
      next.breached = true;
      next.last_crossed_date = date;
      firstDate ??= date;
    }
  }
  if (next.evaluated_through === previous.evaluated_through) return;
  return firstDate !== undefined && outsideThreshold(latest.value, threshold)
    ? { next, crossing: { firstDate, latest } }
    : { next };
}
