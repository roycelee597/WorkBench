import { Button, Dialog } from "@workbench/ui";
import { useState, type FormEvent } from "react";
import type { IndicatorMeta } from "../../../apps/desktop/src/core/finance/finance-reader";
import type {
  FinanceThreshold,
  ThresholdInput,
} from "../../../apps/desktop/src/core/repositories/finance-thresholds";
import { metricLabels, windowLabels } from "./series-view";

const directionLabels = { above: "高于", below: "低于" };
const field = "w-full rounded-md border border-border bg-background px-2 py-1.5";
type Draft = {
  id?: string;
  series_key: string;
  direction: ThresholdInput["direction"];
  level: string;
  hysteresis: string;
  label: string;
  enabled: boolean;
};

function seriesLabel(series: IndicatorMeta["series"][number]) {
  if (!series.window || !series.metric) return series.label;
  const suffix =
    series.window === "raw"
      ? "原始值"
      : windowLabels[
          series.window === "pct_all" ? "all" : series.window === "pct_5y" ? "5y" : "10y"
        ] + "分位";
  return `${series.label} · ${metricLabels[series.metric]} · ${suffix}`;
}

export function ThresholdPanel({
  indicator,
  seriesKey,
  thresholds,
  save,
  remove,
}: {
  indicator: IndicatorMeta;
  seriesKey: string | undefined;
  thresholds: FinanceThreshold[];
  save: (input: ThresholdInput, id?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>();
  const [deleting, setDeleting] = useState<FinanceThreshold>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const seriesNames = new Map(indicator.series.map((series) => [series.key, seriesLabel(series)]));
  async function run(job: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await job();
      setDraft(undefined);
      setDeleting(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存阈值");
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busy) return;
    const { id, level, hysteresis, ...rest } = draft;
    void run(() =>
      save(
        {
          ...rest,
          indicator_id: indicator.id,
          level: Number(level),
          hysteresis: Number(hysteresis),
        },
        id,
      ),
    );
  }
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-label="阈值">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">阈值</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !indicator.series.length}
          onClick={() => {
            setError(undefined);
            setDraft({
              series_key: seriesKey ?? indicator.series[0]?.key ?? "",
              direction: "above",
              level: "",
              hysteresis: "0",
              label: "",
              enabled: true,
            });
          }}
        >
          新增阈值
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        越线时提醒。回差表示触发后需回落或回升多少，才能再次触发。
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!thresholds.length && <p className="text-sm text-muted-foreground">暂无阈值</p>}
      {thresholds.map((item) => {
        const { indicator_id, series_key, direction, level, hysteresis, enabled, label } = item;
        const unit =
          indicator.unit === "percent" &&
          indicator.series.find(({ key }) => key === series_key)?.window !== "raw"
            ? "%"
            : "";
        return (
          <div
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {label || "阈值"} · {directionLabels[direction]} {level}
                {unit}
              </p>
              <p className="text-xs text-muted-foreground">
                {seriesNames.get(series_key) ?? series_key} · 回差 {hysteresis}
                {unit ? " 个百分点" : ""} · {enabled ? "已启用" : "已停用"}
              </p>
            </div>
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={`编辑 ${label || level}`}
                onClick={() => {
                  setError(undefined);
                  setDraft({
                    id: item.id,
                    series_key,
                    direction,
                    level: String(level),
                    hysteresis: String(hysteresis),
                    enabled,
                    label,
                  });
                }}
              >
                编辑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={`${enabled ? "停用" : "启用"} ${label || level}`}
                onClick={() =>
                  void run(() =>
                    save(
                      {
                        indicator_id,
                        series_key,
                        direction,
                        level,
                        hysteresis,
                        enabled: !enabled,
                        label,
                      },
                      item.id,
                    ),
                  )
                }
              >
                {enabled ? "停用" : "启用"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={`删除 ${label || level}`}
                onClick={() => {
                  setError(undefined);
                  setDeleting(item);
                }}
              >
                删除
              </Button>
            </div>
          </div>
        );
      })}
      {draft && (
        <form
          onSubmit={submit}
          className="space-y-3 rounded-lg border border-border p-3"
          aria-label={draft.id ? "编辑阈值" : "新增阈值"}
        >
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <label>
              序列
              <select
                className={field}
                required
                value={draft.series_key}
                onChange={(event) => setDraft({ ...draft, series_key: event.target.value })}
              >
                {[...seriesNames].map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              方向
              <select
                className={field}
                value={draft.direction}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    direction: event.target.value === "below" ? "below" : "above",
                  })
                }
              >
                <option value="above">高于</option>
                <option value="below">低于</option>
              </select>
            </label>
            <label>
              阈值数值
              <input
                className={field}
                type="number"
                step="any"
                required
                value={draft.level}
                onChange={(event) => setDraft({ ...draft, level: event.target.value })}
              />
            </label>
            <label>
              回差
              <input
                className={field}
                type="number"
                step="any"
                min="0"
                required
                value={draft.hysteresis}
                onChange={(event) => setDraft({ ...draft, hysteresis: event.target.value })}
              />
            </label>
            <label className="sm:col-span-2">
              备注
              <input
                className={field}
                value={draft.label}
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setDraft(undefined)}
            >
              取消
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              保存阈值
            </Button>
          </div>
        </form>
      )}
      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(undefined);
        }}
        title="删除阈值"
        description="删除后将停止这条阈值的提醒，已生成的提醒仍可查看。"
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => setDeleting(undefined)}>
              取消
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (deleting) void run(() => remove(deleting.id));
              }}
            >
              确认删除
            </Button>
          </>
        }
      >
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </Dialog>
    </section>
  );
}
