"use client";

import { useEffect, useRef } from "react";
import {
  AreaSeries,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type SeriesMarker,
} from "lightweight-charts";
import type { PriceBar, PriceMarker } from "../types";

function toChartMarker(m: PriceMarker): SeriesMarker<string> {
  const dividend = m.type === "DIVIDEND";
  return {
    time: m.date,
    position: dividend ? "belowBar" : "aboveBar",
    shape: dividend ? "circle" : "square",
    color: dividend ? "#0969da" : "#b45309",
    text: dividend ? "D" : "S",
  };
}

/**
 * Price chart: adjusted close as an area series, volume as a histogram on a
 * separate overlay scale, corporate-action markers (DIVIDEND vs IN_SPECIE
 * visually distinct). Data is fetched in the RSC and passed as props.
 */
export function PriceChart({ bars, markers }: { bars: PriceBar[]; markers: PriceMarker[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      width: el.clientWidth || 640,
      height: 320,
      layout: { background: { color: "#ffffff" }, textColor: "#606770" },
      grid: {
        vertLines: { color: "#f0f1f3" },
        horzLines: { color: "#f0f1f3" },
      },
      timeScale: { borderColor: "#d8dadf" },
      rightPriceScale: { borderColor: "#d8dadf" },
    });

    const closeSeries = chart.addSeries(AreaSeries, {
      lineColor: "#0969da",
      topColor: "rgba(9, 105, 218, 0.18)",
      bottomColor: "rgba(9, 105, 218, 0.02)",
      lineWidth: 2,
      priceLineVisible: false,
    });
    closeSeries.setData(bars.map((b) => ({ time: b.date, value: b.close })));

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      color: "rgba(96, 103, 112, 0.4)",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    volumeSeries.setData(bars.map((b) => ({ time: b.date, value: b.volume })));

    if (markers.length > 0) {
      createSeriesMarkers(
        closeSeries,
        markers.map(toChartMarker).sort((a, b) => a.time.localeCompare(b.time)),
      );
    }

    chart.timeScale().fitContent();

    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
    };
  }, [bars, markers]);

  return <div ref={containerRef} data-testid="price-chart" />;
}
