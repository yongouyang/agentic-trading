import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const addSeries = vi.fn();
const applyOptions = vi.fn();
const fitContent = vi.fn();
const priceScaleApply = vi.fn();
const remove = vi.fn();
const createSeriesMarkers = vi.fn();
const createChart = vi.fn(() => ({
  addSeries,
  priceScale: vi.fn(() => ({ applyOptions: priceScaleApply })),
  applyOptions,
  timeScale: () => ({ fitContent }),
  remove,
}));

vi.mock("lightweight-charts", () => ({
  createChart: (...args: unknown[]) => createChart(...args),
  createSeriesMarkers: (...args: unknown[]) => createSeriesMarkers(...args),
  AreaSeries: "AreaSeries",
  HistogramSeries: "HistogramSeries",
  LineSeries: "LineSeries",
}));

import { PriceChart } from "@/app/components/price-chart";
import type { PriceHistoryIndicators } from "@/app/types";

const bars = [
  { date: "2026-09-01", close: 98.0, volume: 1000 },
  { date: "2026-09-02", close: 99.5, volume: 2000 },
];
const markers = [
  { date: "2026-09-02", type: "DIVIDEND", amount: 2, currency: "HKD" },
  { date: "2026-09-01", type: "IN_SPECIE" },
];

const indicators: PriceHistoryIndicators = {
  sma50: [
    { date: "2026-09-01", value: 97 },
    { date: "2026-09-02", value: 98 },
  ],
  sma200: [{ date: "2026-09-02", value: 96 }],
  mom20: [{ date: "2026-09-02", value: 0.0153 }],
  mom60: [{ date: "2026-09-02", value: 0.042 }],
  mdd252: [
    { date: "2026-09-01", value: -0.12 },
    { date: "2026-09-02", value: -0.1 },
  ],
  vol60: [{ date: "2026-09-02", value: 0.183 }],
};

describe("PriceChart", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates close and volume series and sorts markers by date", () => {
    const setDataClose = vi.fn();
    const setDataVol = vi.fn();
    addSeries.mockReset();
    addSeries
      .mockReturnValueOnce({ setData: setDataClose })
      .mockReturnValueOnce({ setData: setDataVol });

    const { unmount } = render(<PriceChart bars={bars} markers={markers} />);
    expect(screen.getByTestId("price-chart")).toBeInTheDocument();
    expect(createChart).toHaveBeenCalledOnce();

    expect(addSeries).toHaveBeenCalledWith("AreaSeries", expect.objectContaining({ lineColor: "#0969da" }));
    expect(setDataClose).toHaveBeenCalledWith([
      { time: "2026-09-01", value: 98.0 },
      { time: "2026-09-02", value: 99.5 },
    ]);
    expect(addSeries).toHaveBeenCalledWith(
      "HistogramSeries",
      expect.objectContaining({ priceScaleId: "volume" }),
    );
    expect(setDataVol).toHaveBeenCalledWith([
      { time: "2026-09-01", value: 1000 },
      { time: "2026-09-02", value: 2000 },
    ]);
    expect(priceScaleApply).toHaveBeenCalledWith({ scaleMargins: { top: 0.85, bottom: 0 } });

    const chartMarkers = createSeriesMarkers.mock.calls[0][1];
    expect(chartMarkers).toEqual([
      { time: "2026-09-01", position: "aboveBar", shape: "square", color: "#b45309", text: "S" },
      { time: "2026-09-02", position: "belowBar", shape: "circle", color: "#0969da", text: "D" },
    ]);
    expect(fitContent).toHaveBeenCalled();

    unmount();
    expect(remove).toHaveBeenCalled();
  });

  it("skips the markers plugin when there are no markers", () => {
    addSeries.mockReset();
    addSeries.mockReturnValue({ setData: vi.fn() });
    render(<PriceChart bars={bars} markers={[]} />);
    expect(createSeriesMarkers).not.toHaveBeenCalled();
  });

  it("without indicators: only pane-0 series are created and no legend renders", () => {
    addSeries.mockReset();
    addSeries.mockReturnValue({ setData: vi.fn() });
    render(<PriceChart bars={bars} markers={[]} />);
    expect(addSeries).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("chart-legend")).not.toBeInTheDocument();
  });

  describe("with indicators (phase 3c)", () => {
    it("adds SMA overlays to pane 0 and momentum/drawdown/vol series to panes 1–3, % scaled", () => {
      const setData = vi.fn();
      addSeries.mockReset();
      addSeries.mockImplementation(() => ({ setData }));

      render(<PriceChart bars={bars} markers={[]} indicators={indicators} />);
      expect(screen.getByTestId("chart-legend")).toBeInTheDocument();

      // 2 pane-0 base series + 6 indicator series.
      expect(addSeries).toHaveBeenCalledTimes(8);
      const calls = addSeries.mock.calls;
      expect(calls[2]).toEqual(["LineSeries", expect.objectContaining({ color: "#e8590c" }), 0]);
      expect(calls[3]).toEqual(["LineSeries", expect.objectContaining({ color: "#7048e8" }), 0]);
      expect(calls[4]).toEqual(["LineSeries", expect.objectContaining({ color: "#0ca678" }), 1]);
      expect(calls[5]).toEqual(["LineSeries", expect.objectContaining({ color: "#b45309" }), 1]);
      expect(calls[6]).toEqual(["AreaSeries", expect.objectContaining({ lineColor: "#c9372c" }), 2]);
      expect(calls[7]).toEqual(["LineSeries", expect.objectContaining({ color: "#7048e8" }), 3]);

      // setData calls run in the same order as the addSeries calls.
      const data = setData.mock.calls.map((c) => c[0]);
      expect(data[2]).toEqual([
        { time: "2026-09-01", value: 97 },
        { time: "2026-09-02", value: 98 },
      ]); // sma50 raw prices
      expect(data[3]).toEqual([{ time: "2026-09-02", value: 96 }]); // sma200
      expect(data[4]).toEqual([{ time: "2026-09-02", value: 1.53 }]); // mom20 as %
      expect(data[5]).toEqual([{ time: "2026-09-02", value: 4.2 }]); // mom60 as %
      expect(data[6]).toEqual([
        { time: "2026-09-01", value: -12 },
        { time: "2026-09-02", value: -10 },
      ]); // mdd252 as %, ≤ 0
      expect(data[7]).toEqual([{ time: "2026-09-02", value: 18.3 }]); // vol60 as %
    });

    it("renders the static legend as a color key for all six indicators", () => {
      addSeries.mockReset();
      addSeries.mockImplementation(() => ({ setData: vi.fn() }));
      render(<PriceChart bars={bars} markers={[]} indicators={indicators} />);
      const legend = screen.getByTestId("chart-legend");
      for (const key of ["sma50", "sma200", "mom20", "mom60", "mdd252", "vol60"]) {
        expect(legend).toHaveTextContent(key);
      }
      expect(legend.querySelectorAll(".chart-legend-swatch")).toHaveLength(6);
    });
  });
});
