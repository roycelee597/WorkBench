import type { DataLayer } from "../repositories";
import type { NewReminder } from "../repositories/models";
import type { FinanceThreshold, ThresholdInput } from "../repositories/finance-thresholds";
import type { FinancePoint, IndicatorMeta } from "./finance-reader";
import type { FinanceDataSource, UpdateMode } from "./local-sidecar-source";
import { FINANCE_WORKBENCH, type FinanceTarget } from "./finance-target";
import { evaluateThreshold, type ThresholdPoint } from "./threshold-evaluator";

type AlertData = Pick<DataLayer, "financeThresholds" | "financeAlertStates" | "reminders">;
type IndicatorSource = Pick<FinanceDataSource, "listIndicators" | "getRecent" | "getSeries">;
type Crossing = NonNullable<ReturnType<typeof evaluateThreshold>>["crossing"];
type Trigger = {
  threshold: FinanceThreshold;
  crossing: NonNullable<Crossing>;
};

function dateText(day: number) {
  const value = String(day);
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
}

function describe({ threshold, crossing }: Trigger, indicator: IndicatorMeta | undefined) {
  const series = indicator?.series.find(({ key }) => key === threshold.series_key);
  const percent = indicator?.unit === "percent" && series?.window !== "raw";
  const decimals = series?.window === "raw" ? 2 : (indicator?.decimals ?? 1);
  const format = (value: number) => value.toFixed(decimals) + (percent ? "%" : "");
  const title = `${series?.index ? series.label + " " : ""}${indicator?.name ?? threshold.indicator_id}${threshold.direction === "above" ? "升至" : "降至"} ${format(crossing.latest.value)}（阈值 ${format(threshold.level)}）`;
  const notes = `${title}。数据日期 ${dateText(crossing.latest.trade_date)}，首次越线 ${dateText(crossing.firstDate)}。${threshold.label ? ` ${threshold.label}` : ""}`;
  return { title, notes };
}

function reminderGroups(triggers: Trigger[]) {
  return triggers.length >= 3 ? [triggers] : triggers.map((trigger) => [trigger]);
}

function available(point: FinancePoint): point is FinancePoint & ThresholdPoint {
  return point.value !== null;
}

export class FinanceAlerts {
  private pending = Promise.resolve();
  constructor(
    private readonly source: IndicatorSource,
    private readonly getData: () => Promise<AlertData>,
    private readonly now = Date.now,
    private readonly onError: (error: unknown) => void = console.error,
  ) {}

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.pending.then(job);
    this.pending = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  list() {
    return this.enqueue(() => this.evaluateCurrent("auto", true));
  }

  evaluate(mode: UpdateMode = "auto") {
    return this.enqueue(() => this.evaluateCurrent(mode));
  }

  save(fields: ThresholdInput, id?: string) {
    return this.enqueue(async () => {
      const indicators = await this.source.listIndicators();
      const indicator = indicators.find(({ id }) => id === fields.indicator_id);
      if (!indicator?.series.some(({ key }) => key === fields.series_key))
        throw new Error("请选择当前指标下的有效序列");
      const { financeThresholds } = await this.getData();
      if (id) await financeThresholds.update(id, fields);
      else await financeThresholds.create(fields);
      await this.evaluateCurrent("auto", true).catch(this.onError);
      return financeThresholds.list();
    });
  }

  delete(id: string) {
    return this.enqueue(async () => {
      const { financeThresholds } = await this.getData();
      await financeThresholds.softDelete(id);
      return financeThresholds.list();
    });
  }

  private async evaluateCurrent(
    mode: UpdateMode = "auto",
    baselineOnly = false,
  ): Promise<FinanceThreshold[]> {
    const { financeThresholds, financeAlertStates, reminders } = await this.getData();
    const indicators = await this.source.listIndicators();
    await financeThresholds.ensureDefaults(indicators);
    const thresholds = await financeThresholds.list();
    const enabled = thresholds.filter(({ enabled }) => enabled);
    if (!enabled.length) return thresholds;
    const [latestSeries, states] = await Promise.all([
      this.source.getRecent([...new Set(enabled.map(({ series_key }) => series_key))]),
      financeAlertStates.list(),
    ]);
    const byThreshold = new Map(states.map((state) => [state.threshold_id, state]));
    const latest = new Map(
      latestSeries.map(({ key, points }) => [key, points.filter(available).at(-1)]),
    );
    const ranges = new Map<string, { from: number; to: number }>();
    if (!baselineOnly && mode !== "full-rebuild") {
      for (const threshold of enabled) {
        const state = byThreshold.get(threshold.id);
        const through = latest.get(threshold.series_key)?.trade_date;
        if (
          state?.threshold_version !== threshold.updated_at ||
          through === undefined ||
          state.evaluated_through >= through
        )
          continue;
        const previous = ranges.get(threshold.series_key);
        ranges.set(threshold.series_key, {
          from: Math.min(previous?.from ?? Infinity, state.evaluated_through + 1),
          to: through,
        });
      }
    }
    const points = new Map<string, ThresholdPoint[]>();
    await Promise.all(
      [...ranges].map(async ([key, range]) => {
        const [series] = await this.source.getSeries([key], range);
        points.set(key, series?.points.filter(available) ?? []);
      }),
    );
    const updates = [];
    const triggers: Trigger[] = [];
    for (const threshold of enabled) {
      const previous = byThreshold.get(threshold.id);
      const result = evaluateThreshold(
        threshold,
        previous,
        latest.get(threshold.series_key),
        points.get(threshold.series_key) ?? [],
        mode === "full-rebuild",
      );
      if (!result) continue;
      updates.push({ next: result.next, previous });
      if (result.crossing) triggers.push({ threshold, crossing: result.crossing });
    }
    const now = this.now();
    const writes = [];
    for (const group of reminderGroups(triggers)) {
      const [first] = group;
      if (!first) continue;
      const descriptions = group.map((trigger) =>
        describe(
          trigger,
          indicators.find(({ id }) => id === trigger.threshold.indicator_id),
        ),
      );
      const input: NewReminder = {
        title:
          "金融指标：" +
          (descriptions.length === 1 ? descriptions[0]!.title : `${group.length} 条阈值被触发`),
        notes: descriptions.map(({ notes }) => notes).join("\n"),
        source: "manual",
        source_workbench: FINANCE_WORKBENCH,
        priority: 2,
        due_at: now,
      };
      const target: FinanceTarget = {
        indicatorId: first.threshold.indicator_id,
        seriesKey: first.threshold.series_key,
      };
      const write = await reminders.prepareCreate(input);
      const ids = new Set(group.map(({ threshold }) => threshold.id));
      for (const { next } of updates)
        if (ids.has(next.threshold_id)) next.last_reminder_id = write.id;
      writes.push({ ...write, target });
    }
    await financeAlertStates.commit(updates, writes);
    return thresholds;
  }
}
