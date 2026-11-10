import { useEffect, useRef } from "react";
import { init, use, type EChartsType } from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { overlayName, type FinanceChartOption } from "../chart-option";

use([
  LineChart,
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  MarkLineComponent,
  LegendComponent,
  CanvasRenderer,
]);

export function Chart({
  option,
  label,
  onOverlay,
}: {
  option: FinanceChartOption;
  label: string;
  onOverlay: (enabled: boolean) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType>(null);
  useEffect(() => {
    if (!container.current) return;
    const instance = init(container.current, undefined, { renderer: "canvas" });
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);
  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);
  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    function selected(event: unknown) {
      if (
        !event ||
        typeof event !== "object" ||
        !("name" in event) ||
        event.name !== overlayName ||
        !("selected" in event) ||
        !event.selected ||
        typeof event.selected !== "object" ||
        !(overlayName in event.selected)
      )
        return;
      onOverlay(event.selected[overlayName] === true);
    }
    instance.on("legendselectchanged", selected);
    return () => {
      if (!instance.isDisposed()) instance.off("legendselectchanged", selected);
    };
  }, [onOverlay]);
  return <div ref={container} role="img" aria-label={label} className="h-[360px] w-full min-w-0" />;
}
