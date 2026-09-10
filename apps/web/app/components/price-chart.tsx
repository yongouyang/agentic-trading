"use client";

import { useEffect, useRef } from "react";
import {
  AreaSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type SeriesMarker,
} from "lightweight-charts";
import type { IndicatorPoint, PriceBar, PriceHistoryIndicators, PriceMarker } from "../types";

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

/** Indicator series colors — keep in sync with the static legend row below. */
const INDICATOR_COLORS = {
  sma50: "#e8590c",
  sma200: "#7048e8",
  mom20: "#0ca678",
  mom60: "#b45309",
  mdd252: "#c9372c",
  vol60: "#7048e8",
} as const;

/** Sub-pane series carry ratios — scale to % for display. */
const PCT_FORMAT = { type: "custom", formatter: (v: number) => `${v.toFixed(1)}%` } as const;

function toPoints(pts: IndicatorPoint[], pct = false) {
  return pts.map((p) => ({ time: p.date, value: pct ? p.value * 100 : p.value }));
}

/**
 * Price chart: adjusted close as an area series, volume as a histogram on a
 * separate overlay scale, corporate-action markers (DIVIDEND vs IN_SPECIE
 * visually distinct). Data is fetched in the RSC and passed as props.
 *
 * Phase-3c: with the optional `indicators` prop the chart gains SMA50/SMA200
 * overlays on the price pane plus three sub-panes (momentum, drawdown,
 * volatility, all rendered as %) and a static CSS legend row. Without it the
 * chart renders exactly as before.
 */
export function PriceChart({
  bars,
  markers,
  indicators,
}: {
  bars: PriceBar[];
  markers: PriceMarker[];
  indicators?: PriceHistoryIndicators;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      width: el.clientWidth || 640,
      height: indicators ? 560 : 320,
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

    if (indicators) {
      const sma50 = chart.addSeries(
        LineSeries,
        { color: INDICATOR_COLORS.sma50, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
        0,
      );
      sma50.setData(toPoints(indicators.sma50));
      const sma200 = chart.addSeries(
        LineSeries,
        { color: INDICATOR_COLORS.sma200, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
        0,
      );
      sma200.setData(toPoints(indicators.sma200));

      const mom20 = chart.addSeries(
        LineSeries,
        { color: INDICATOR_COLORS.mom20, lineWidth: 1, priceLineVisible: false, priceFormat: PCT_FORMAT },
        1,
      );
      mom20.setData(toPoints(indicators.mom20, true));
      const mom60 = chart.addSeries(
        LineSeries,
        { color: INDICATOR_COLORS.mom60, lineWidth: 1, priceLineVisible: false, priceFormat: PCT_FORMAT },
        1,
      );
      mom60.setData(toPoints(indicators.mom60, true));

      const mdd = chart.addSeries(
        AreaSeries,
        {
          lineColor: INDICATOR_COLORS.mdd252,
          topColor: "rgba(201, 55, 44, 0.02)",
          bottomColor: "rgba(201, 55, 44, 0.25)",
          lineWidth: 1,
          priceLineVisible: false,
          priceFormat: PCT_FORMAT,
        },
        2,
      );
      mdd.setData(toPoints(indicators.mdd252, true));

      const vol = chart.addSeries(
        LineSeries,
        { color: INDICATOR_COLORS.vol60, lineWidth: 1, priceLineVisible: false, priceFormat: PCT_FORMAT },
        3,
      );
      vol.setData(toPoints(indicators.vol60, true));
    }

    chart.timeScale().fitContent();

    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
    };
  }, [bars, markers, indicators]);

  return (
    <>
      {indicators && (
        <div className="chart-legend" data-testid="chart-legend">
          {(Object.keys(INDICATOR_COLORS) as (keyof typeof INDICATOR_COLORS)[]).map((k) => (
            <span key={k} className="chart-legend-key">
              <span className="chart-legend-swatch" style={{ background: INDICATOR_COLORS[k] }} />
              {k}
            </span>
          ))}
        </div>
      )}
      <div ref={containerRef} data-testid="price-chart" />
    </>
  );
}
