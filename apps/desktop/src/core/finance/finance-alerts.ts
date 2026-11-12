import type { DataLayer } from "../repositories";
import type { NewReminder } from "../repositories/models";
import type { FinanceThreshold, ThresholdInput } from "../repositories/finance-thresholds";
import type { FinanceDone } from "./engine-events";
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
  private completions: { event: FinanceDone; mode: UpdateMode }[] = [];
  constructor(
    private readonly source: IndicatorSource,
    private readonly getData: () => Promise<AlertData>,
    private readonly now = Date.now,
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
    return this.enqueue(async () => (await this.flushCompletions()) ?? this.evaluate());
  }

  complete(event: FinanceDone, mode: UpdateMode = "auto") {
    return this.enqueue(async () => {
      this.completions.push({ event, mode });
      await this.flushCompletions();
    });
  }

  private async flushCompletions() {
    let thresholds: FinanceThreshold[] | undefined;
    for (let first = this.completions[0]; first; first = this.completions[0]) {
      thresholds = await this.evaluate(first.event, first.mode);
      // 事务失败时保留这一轮，下一次读取或更新先重试。
      this.completions.shift();
    }
    return thresholds;
  }

  save(fields: ThresholdInput, id?: string) {
    return this.enqueue(async () => {
      await this.flushCompletions();
      const indicators = await this.source.listIndicators();
      const indicator = indicators.find(({ id }) => id === fields.indicator_id);
      if (!indicator?.series.some(({ key }) => key === fields.series_key))
        throw new Error("请选择当前指标下的有效序列");
      const { financeThresholds } = await this.getData();
      if (id) await financeThresholds.update(id, fields);
      else await financeThresholds.create(fields);
      return this.evaluate();
    });
  }

  delete(id: string) {
    return this.enqueue(async () => {
      await this.flushCompletions();
      const { financeThresholds } = await this.getData();
      await financeThresholds.softDelete(id);
      return financeThresholds.list();
    });
  }

  private async evaluate(
    event?: FinanceDone,
    mode: UpdateMode = "auto",
  ): Promise<FinanceThreshold[]> {
    const { financeThresholds, financeAlertStates, reminders } = await this.getData();
    const indicators = await this.source.listIndicators();
    await financeThresholds.ensureDefaults(indicators);
    const thresholds = await financeThresholds.list();
    const enabled = thresholds.filter(({ enabled }) => enabled);
    if (!enabled.length || event?.status === "failed") return thresholds;
    const [latestSeries, states] = await Promise.all([
      this.source.getRecent([...new Set(enabled.map(({ series_key }) => series_key))]),
      financeAlertStates.list(),
    ]);
    const byThreshold = new Map(states.map((state) => [state.threshold_id, state]));
    const latest = new Map(
      latestSeries.map(({ key, points }) => [key, points.filter(available).at(-1)]),
    );
    const fresh = new Map<string, Set<number>>();
    if (event && mode !== "full-rebuild") {
      for (const threshold of enabled) {
        const state = byThreshold.get(threshold.id);
        if (state?.threshold_version !== threshold.updated_at) continue;
        const dates = fresh.get(threshold.series_key) ?? new Set<number>();
        for (const day of event.new_dates[threshold.series_key] ?? [])
          if (Number(day) > state.evaluated_through) dates.add(Number(day));
        if (dates.size) fresh.set(threshold.series_key, dates);
      }
    }
    const points = new Map<string, ThresholdPoint[]>();
    if (fresh.size) {
      const dates = [...fresh.values()].flatMap((days) => [...days]);
      const range = dates.reduce(
        ({ from, to }, day) => ({ from: Math.min(from, day), to: Math.max(to, day) }),
        { from: Infinity, to: -Infinity },
      );
      for (const { key, points: series } of await this.source.getSeries([...fresh.keys()], range))
        points.set(
          key,
          series.filter((point) => fresh.get(key)?.has(point.trade_date)).filter(available),
        );
    }
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
