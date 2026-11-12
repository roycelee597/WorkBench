import { Button } from "@workbench/ui";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type {
  FinancePoint,
  IndicatorMeta,
} from "../../../apps/desktop/src/core/finance/finance-reader";
import { outsideThreshold } from "../../../apps/desktop/src/core/finance/threshold-evaluator";
import type { FinanceThreshold } from "../../../apps/desktop/src/core/repositories/finance-thresholds";
import type { financeApi } from "./api";
import { buildChartOption } from "./chart-option";
import { Chart } from "./components/Chart";
import { ThresholdPanel } from "./ThresholdPanel";
import { beijingDay, monthlyAverage } from "./monthly";
import { readPreferences, type FinancePreferences, type FinanceRange } from "./preferences";
import {
  displayValue,
  financeDate,
  latestPoints,
  metricLabels,
  resolveSeries,
  viewLabels,
  windowLabels,
} from "./series-view";

export type FinanceDashboardData = Pick<
  typeof financeApi,
  | "listIndicators"
  | "getRecent"
  | "getSeries"
  | "getOverlay"
  | "loadPreferences"
  | "savePreference"
  | "loadThresholds"
  | "saveThreshold"
  | "deleteThreshold"
>;

type Props = {
  api: FinanceDashboardData;
  revision: number;
  busy: boolean;
  configured: boolean;
  update: () => void;
  openSettings: () => void;
};

const ranges: { value: FinanceRange; label: string }[] = [
  { value: "1y", label: "1 年" },
  { value: "3y", label: "3 年" },
  { value: "5y", label: "5 年" },
  { value: "all", label: "全部" },
];
const views = [
  { value: "daily", label: "日线" },
  { value: "monthly", label: "月均" },
] as const;
const emptyPoints: FinancePoint[] = [];
const emptyThresholds: FinanceThreshold[] = [];

function BreachBadges({
  thresholds,
  value,
  showNormal = false,
}: {
  thresholds: FinanceThreshold[];
  value?: number | null | undefined;
  showNormal?: boolean;
}) {
  if (value == null) return null;
  const breached = thresholds.filter((threshold) => outsideThreshold(value, threshold));
  if (showNormal && thresholds.length && !breached.length)
    return <span className="rounded-full bg-muted px-2 py-1 text-xs text-primary">正常</span>;
  return breached.map((threshold) => (
    <span
      key={threshold.id}
      className="rounded-full bg-muted px-2 py-1 text-xs text-destructive"
      title={threshold.label}
    >
      {threshold.direction === "above" ? "已高于阈值" : "已低于阈值"}
    </span>
  ));
}

function useRequest<T>(request: () => Promise<T>) {
  const [state, setState] = useState<{ request: () => Promise<T>; value?: T; error?: string }>();
  useEffect(() => {
    let live = true;
    void request().then(
      (value) => {
        if (live) setState({ request, value });
      },
      (error: unknown) => {
        if (live)
          setState((previous) => ({
            ...previous,
            request,
            error: error instanceof Error ? error.message : "暂时无法读取金融数据",
          }));
      },
    );
    return () => {
      live = false;
    };
  }, [request]);
  return { value: state?.value, error: state?.error, pending: state?.request !== request };
}

function subscribeTheme(changed: () => void) {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function getDarkTheme() {
  return document.documentElement.classList.contains("dark");
}

function Choices<T extends string>({
  label,
  choices,
  selected,
  onSelect,
}: {
  label: string;
  choices: readonly { value: T; label: string }[];
  selected?: T | undefined;
  onSelect: (value: T) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1"
    >
      {choices.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={selected === item.value}
          className={
            selected === item.value
              ? "rounded-md bg-card px-3 py-1.5 text-sm font-semibold text-primary shadow-sm"
              : "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-card"
          }
          onClick={() => onSelect(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function Description({ text }: { text: string }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5" aria-label="指标说明">
      <h2 className="mb-2 font-semibold">指标说明</h2>
      {text
        .split("\n")
        .filter(Boolean)
        .map((line, index) => (
          <p className="text-sm leading-6 text-muted-foreground" key={index}>
            {line.split(/(\*\*[^*]+\*\*)/).map((part, offset) =>
              part.startsWith("**") && part.endsWith("**") ? (
                <strong className="text-foreground" key={offset}>
                  {part.slice(2, -2)}
                </strong>
              ) : (
                part
              ),
            )}
          </p>
        ))}
    </section>
  );
}

function catalogGroups(metadata: IndicatorMeta[], prefs: FinancePreferences) {
  const groups = new Map<
    string,
    { id: string; label: string; index?: string; choice: ReturnType<typeof resolveSeries> }[]
  >();
  for (const item of metadata) {
    const rows = groups.get(item.group) ?? [];
    if (item.dimensions) {
      for (const index of item.dimensions.indices)
        rows.push({
          id: item.id,
          label: index.label,
          index: index.value,
          choice: resolveSeries(item, prefs, index.value),
        });
    } else rows.push({ id: item.id, label: item.name, choice: resolveSeries(item, prefs) });
    groups.set(item.group, rows);
  }
  return [...groups];
}

export function FinanceDashboard({ api, revision, busy, configured, update, openSettings }: Props) {
  const dark = useSyncExternalStore(subscribeTheme, getDarkTheme, () => false);
  const initial = useRequest(useCallback(() => api.loadPreferences(), [api]));
  const [changes, setChanges] = useState<Partial<FinancePreferences>>({});
  const [saveError, setSaveError] = useState<string>();
  const prefs = useMemo(
    () => ({ ...readPreferences({}), ...initial.value, ...changes }),
    [initial.value, changes],
  );
  const catalog = useRequest(useCallback(() => api.listIndicators(), [api, revision]));
  const [thresholdRevision, setThresholdRevision] = useState(0);
  const savedThresholds = useRequest(
    useCallback(() => api.loadThresholds(), [api, revision, thresholdRevision]),
  );
  const allThresholds = savedThresholds.value ?? emptyThresholds;
  const meta = catalog.value?.find((item) => item.id === prefs.indicator) ?? catalog.value?.[0];
  const groups = useMemo(() => catalogGroups(catalog.value ?? [], prefs), [catalog.value, prefs]);
  const choice = meta && resolveSeries(meta, prefs);
  const key = choice?.series?.key;
  const recentKeys = JSON.stringify([
    ...new Set(
      [
        ...groups.flatMap(([, rows]) => rows.map(({ choice: row }) => row.series?.key)),
        choice?.raw?.key,
      ].filter((item): item is string => Boolean(item)),
    ),
  ]);
  const recent = useRequest(
    useCallback(
      () => api.getRecent(JSON.parse(recentKeys) as string[]),
      [api, recentKeys, revision],
    ),
  );
  const series = useRequest(
    useCallback(() => (key ? api.getSeries([key]) : Promise.resolve([])), [api, key, revision]),
  );
  const overlayOn = Boolean(meta?.views?.overlay_hs300 && prefs.overlay);
  const overlay = useRequest(
    useCallback(
      () => (overlayOn ? api.getOverlay() : Promise.resolve([])),
      [api, overlayOn, revision],
    ),
  );
  const points = series.value?.find((item) => item.key === key)?.points ?? emptyPoints;
  const latest = latestPoints(
    recent.value?.find((item) => item.key === key)?.points ?? emptyPoints,
  );
  const raw = latestPoints(
    recent.value?.find((item) => item.key === choice?.raw?.key)?.points ?? emptyPoints,
  ).latest;
  const monthly = Boolean(meta?.views?.monthly_avg && prefs.top5View === "monthly");
  const today = beijingDay(new Date());
  const visible = useMemo(
    () => (monthly ? monthlyAverage(points, today) : points),
    [monthly, points, today],
  );
  const name =
    choice?.index && choice.metric
      ? [
          choice.index.label,
          metricLabels[choice.metric],
          choice.view === "raw"
            ? "原始值"
            : choice.window
              ? windowLabels[choice.window] + "分位"
              : "分位",
        ].join(" ")
      : (meta?.name ?? "金融指标");
  const last = points.at(-1)?.trade_date;
  const thresholds = useMemo(
    () => allThresholds.filter((entry) => entry.series_key === key && entry.enabled),
    [allThresholds, key],
  );
  const first = choice?.start ?? 20150101;
  const percent = choice?.percent ?? false;
  const percentile = choice?.view === "percentile";
  const decimals = choice?.decimals ?? 1;
  const overlayPoints = overlayOn ? (overlay.value ?? emptyPoints) : emptyPoints;
  const option = useMemo(
    () =>
      last != null && visible.some((point) => point.value != null)
        ? buildChartOption(visible, overlayPoints, thresholds, {
            name: monthly ? "月均" : name,
            percent,
            percentile,
            decimals,
            dark,
            range: prefs.range,
            first,
            last,
          })
        : undefined,
    [
      visible,
      overlayPoints,
      thresholds,
      monthly,
      name,
      percent,
      percentile,
      decimals,
      dark,
      prefs.range,
      first,
      last,
    ],
  );
  const error =
    catalog.error ??
    series.error ??
    recent.error ??
    overlay.error ??
    initial.error ??
    savedThresholds.error ??
    saveError;
  const loading = catalog.pending || series.pending || recent.pending;

  const setPreference = useCallback(
    <K extends keyof FinancePreferences>(field: K, value: FinancePreferences[K]) => {
      setChanges((previous) => ({ ...previous, [field]: value }));
      setSaveError(undefined);
      void api.savePreference(field, value).catch(() => setSaveError("未能保存显示设置"));
    },
    [api],
  );
  const setOverlay = useCallback(
    (enabled: boolean) => setPreference("overlay", enabled),
    [setPreference],
  );
  const value = latest.latest?.value;
  const prior = latest.previous?.value;
  const delta = value != null && prior != null ? value - prior : null;

  return (
    <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
      <aside className="rounded-xl border border-border bg-card p-3" aria-label="指标目录">
        <h2 className="px-2 pb-2 font-semibold">指标目录</h2>
        {!groups.length && (
          <p className="px-2 pb-2 text-sm text-muted-foreground">
            {loading ? "正在读取指标…" : "暂无指标"}
          </p>
        )}
        {groups.map(([group, rows]) => (
          <details key={group} open className="border-t border-border py-2">
            <summary className="cursor-pointer px-2 py-1 text-sm font-medium">{group}</summary>
            {rows.map((row) => {
              const rowKey = row.choice.series?.key;
              const latestRow = latestPoints(
                recent.value?.find((entry) => entry.key === rowKey)?.points ?? emptyPoints,
              ).latest;
              const selected = meta?.id === row.id && row.index === choice?.index?.value;
              return (
                <button
                  key={row.id + (row.index ?? "")}
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  className={
                    selected
                      ? "flex w-full items-center justify-between gap-2 rounded-lg bg-accent px-2 py-2 text-left text-sm text-primary"
                      : "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted"
                  }
                  onClick={() => {
                    setPreference("indicator", row.id);
                    if (row.index) setPreference("valuationIndex", row.index);
                  }}
                >
                  <span className="flex flex-wrap items-center gap-1">
                    {row.label}
                    <BreachBadges
                      thresholds={allThresholds.filter(
                        (threshold) => threshold.enabled && threshold.series_key === rowKey,
                      )}
                      value={latestRow?.value}
                    />
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {displayValue(latestRow?.value, row.choice.percent, row.choice.decimals)}
                  </span>
                </button>
              );
            })}
          </details>
        ))}
      </aside>

      <section className="min-w-0 space-y-4" aria-label="指标详情">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{name}</h1>
            <p className="text-sm text-muted-foreground">
              数据截至 {financeDate(latest.latest?.trade_date ?? raw?.trade_date)}
            </p>
          </div>
          <Button disabled={!configured || busy} onClick={update}>
            {busy ? "更新中…" : "立即更新"}
          </Button>
        </header>
        {error && (
          <div
            className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 text-destructive"
            role="alert"
          >
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={openSettings}>
              去设置
            </Button>
          </div>
        )}
        {meta && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-border bg-card p-4">
            <div>
              <p className="text-sm text-muted-foreground">当前值</p>
              <strong className="text-2xl tabular-nums">
                {displayValue(value, percent, decimals)}
              </strong>
            </div>
            <p className="text-sm text-muted-foreground">
              较前一交易日{" "}
              {delta == null
                ? "—"
                : (delta >= 0 ? "+" : "") + delta.toFixed(decimals) + (percent ? " 个百分点" : "")}
            </p>
            {choice?.index && choice.view !== "raw" && (
              <p className="text-sm text-muted-foreground">
                原始 {choice.metric && metricLabels[choice.metric]}{" "}
                {displayValue(raw?.value, false, 2)}
              </p>
            )}
            <BreachBadges thresholds={thresholds} value={value} showNormal />
          </div>
        )}
        {meta && (
          <ThresholdPanel
            key={meta.id}
            indicator={meta}
            seriesKey={key}
            thresholds={allThresholds.filter((threshold) => threshold.indicator_id === meta.id)}
            save={async (fields, id) => {
              await api.saveThreshold(fields, id);
              setThresholdRevision((value) => value + 1);
            }}
            remove={async (id) => {
              await api.deleteThreshold(id);
              setThresholdRevision((value) => value + 1);
            }}
          />
        )}
        {meta && (
          <section
            className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4"
            aria-label="指标折线图"
          >
            {meta.dimensions && (
              <div className="flex flex-wrap gap-2">
                <Choices
                  label="指数"
                  choices={meta.dimensions.indices}
                  selected={choice?.index?.value}
                  onSelect={(selected) => setPreference("valuationIndex", selected)}
                />
                <Choices
                  label="估值指标"
                  choices={meta.dimensions.metrics.map((value) => ({
                    value,
                    label: metricLabels[value],
                  }))}
                  selected={choice?.metric}
                  onSelect={(selected) => setPreference("valuationMetric", selected)}
                />
                <Choices
                  label="估值窗口"
                  choices={meta.dimensions.windows.map((value) => ({
                    value,
                    label: windowLabels[value],
                  }))}
                  selected={choice?.window}
                  onSelect={(selected) => setPreference("valuationWindow", selected)}
                />
                <Choices
                  label="估值视图"
                  choices={meta.dimensions.views.map((value) => ({
                    value,
                    label: viewLabels[value],
                  }))}
                  selected={choice?.view}
                  onSelect={(selected) => setPreference("valuationView", selected)}
                />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Choices
                label="显示范围"
                choices={ranges}
                selected={prefs.range}
                onSelect={(selected) => setPreference("range", selected)}
              />
              {meta.views?.monthly_avg && (
                <Choices
                  label="成交额视图"
                  choices={views}
                  selected={prefs.top5View}
                  onSelect={(selected) => setPreference("top5View", selected)}
                />
              )}
              {meta.views?.overlay_hs300 && (
                <label className="ml-auto flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={prefs.overlay}
                    onChange={(event) => setOverlay(event.target.checked)}
                  />
                  叠加沪深300
                </label>
              )}
            </div>
            {option ? (
              <Chart option={option} label={name + "的历史折线图"} onOverlay={setOverlay} />
            ) : (
              <div
                className="grid min-h-56 place-items-center p-4 text-sm text-muted-foreground"
                role="status"
              >
                {loading || busy
                  ? "数据正在准备…"
                  : error
                    ? "图表暂时无法读取"
                    : "所选序列暂无可用数据"}
              </div>
            )}
            {monthly && visible.some((point) => "monthToDate" in point && point.monthToDate) && (
              <p className="text-sm text-muted-foreground">
                本月至今按已发布的交易日日值计算。阈值仍按日值判断。
              </p>
            )}
          </section>
        )}
        {!meta && (
          <p
            className="rounded-xl border border-border bg-card p-5 text-muted-foreground"
            role="status"
          >
            {loading || busy
              ? "数据正在准备…"
              : error
                ? "无法读取指标目录"
                : "更新行情后，这里会显示指标图表。"}
          </p>
        )}
        {!configured && (
          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="font-semibold">连接 Tushare</h2>
            <p className="my-2 text-sm text-muted-foreground">
              先在 设置 → 金融指标 填写 Tushare token。
            </p>
            <Button variant="outline" onClick={openSettings}>
              去设置
            </Button>
          </section>
        )}
        {meta?.description_md && <Description text={meta.description_md} />}
      </section>
    </div>
  );
}
