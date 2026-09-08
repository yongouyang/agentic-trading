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
}));

import { PriceChart } from "@/app/components/price-chart";

const bars = [
  { date: "2026-09-01", close: 98.0, volume: 1000 },
  { date: "2026-09-02", close: 99.5, volume: 2000 },
];
const markers = [
  { date: "2026-09-02", type: "DIVIDEND", amount: 2, currency: "HKD" },
  { date: "2026-09-01", type: "IN_SPECIE" },
];

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
});
