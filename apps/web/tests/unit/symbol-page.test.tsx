import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepDiveReport, PriceHistory, RunSummary } from "@/app/types";

// PriceChart is a client component backed by lightweight-charts (canvas);
// stub it here — its own test mocks the library. RunPicker is a client
// component too (its own tests live in run-picker.test.tsx).
vi.mock("@/app/components/price-chart", () => ({
  PriceChart: (props: { bars: unknown[]; markers: unknown[]; indicators?: { sma50: unknown[] } }) => (
    <div data-testid="price-chart">
      bars:{props.bars.length} markers:{props.markers.length}
      {props.indicators ? ` sma50:${props.indicators.sma50.length}` : " no-indicators"}
    </div>
  ),
}));
vi.mock("@/app/components/run-picker", () => ({
  RunPicker: (props: { runs: RunSummary[]; param: string; current?: number }) => (
    <div data-testid="run-picker">
      param:{props.param} current:{props.current ?? "latest"} runs:{props.runs.map((r) => r.id).join(",")}
    </div>
  ),
}));

import SymbolPage from "@/app/symbol/[symbol]/page";

const deepDiveFixture: DeepDiveReport = {
  run: { id: 7, runAt: "2026-09-06T08:00:00.000Z", market: "HK", screenRunId: 12, topN: 2 },
  symbol: "0005.HK",
  status: "ok",
  verdict: {
    instrumentId: "0005.HK",
    rating: "buy",
    conviction: 0.6,
    abstain: true,
    thesis: "solid momentum, cheap valuation",
    keyRisks: ["rate sensitivity"],
    invalidationConditions: ["breaks below 200d SMA"],
    asOf: "2026-09-05",
    promptVersion: "v1",
  },
  transcript: [
    {
      hash: "h1",
      agent: "news-analyst",
      model: "k3-256k",
      promptVersion: "v1",
      usage: { promptTokens: 14, completionTokens: 9 },
      systemPrompt: "sys news",
      userPrompt: "user news",
      responseText: "news response",
    },
    {
      hash: "h2",
      agent: "verdict",
      model: "k3",
      promptVersion: "v1",
      usage: null,
      systemPrompt: "sys verdict",
      userPrompt: "user verdict",
      responseText: "verdict response",
    },
  ],
};

const priceHistoryFixture: PriceHistory = {
  symbol: "0005.HK",
  days: 250,
  bars: [{ date: "2026-09-01", close: 98.02, volume: 1000 }],
  markers: [{ date: "2026-09-03", type: "DIVIDEND", amount: 2, currency: "HKD" }],
};

function stubFetch(handler: (url: string) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const out = handler(String(input));
      if (out instanceof Error) throw out;
      return out as Response;
    }),
  );
}

const ok = (body: unknown) => ({ status: 200, ok: true, json: async () => body });

describe("symbol detail page", () => {
  beforeEach(() => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders verdict card, chart, and transcript", async () => {
    stubFetch((url) =>
      url.includes("/reports/deep-dive") ? ok(deepDiveFixture) : ok(priceHistoryFixture),
    );
    render(
      await SymbolPage({
        params: Promise.resolve({ symbol: "0005.HK" }),
        searchParams: Promise.resolve({ run: "7" }),
      }),
    );
    const card = screen.getByTestId("verdict-card");
    expect(card).toHaveTextContent("solid momentum, cheap valuation");
    expect(screen.getByTestId("rating-badge")).toHaveTextContent("buy");
    expect(screen.getByTestId("abstain-badge")).toHaveTextContent("abstain");
    expect(card).toHaveTextContent("rate sensitivity");
    expect(card).toHaveTextContent("breaks below 200d SMA");
    expect(screen.getByTestId("price-chart")).toHaveTextContent("bars:1 markers:1");
    const entries = screen.getAllByTestId("transcript-entry");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent("news-analyst");
    expect(entries[0]).toHaveTextContent("14+9 tokens");
    // verdict agent response expanded by default, others collapsed
    const responses = screen.getAllByTestId("response-text");
    expect(responses[1]!.closest("details")).toHaveAttribute("open");
    expect(responses[0]!.closest("details")).not.toHaveAttribute("open");
  });

  it("renders a chart placeholder when price history 404s, keeping the rest", async () => {
    stubFetch((url) =>
      url.includes("/reports/deep-dive") ? ok(deepDiveFixture) : { status: 404, ok: false },
    );
    render(
      await SymbolPage({
        params: Promise.resolve({ symbol: "0005.HK" }),
        searchParams: Promise.resolve({ run: "7" }),
      }),
    );
    expect(screen.getByTestId("chart-unavailable")).toHaveTextContent("price history unavailable");
    expect(screen.getByTestId("verdict-card")).toBeInTheDocument();
  });

  it("renders an invalid state when run param is missing or not a number", async () => {
    stubFetch(() => ok(deepDiveFixture));
    render(
      await SymbolPage({
        params: Promise.resolve({ symbol: "0005.HK" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(screen.getByText(/invalid link/)).toBeInTheDocument();
    render(
      await SymbolPage({
        params: Promise.resolve({ symbol: "0005.HK" }),
        searchParams: Promise.resolve({ run: "abc" }),
      }),
    );
    expect(screen.getAllByText(/invalid link/)).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders api: unreachable when the deep-dive fetch fails", async () => {
    stubFetch(() => new Error("down"));
    render(
      await SymbolPage({
        params: Promise.resolve({ symbol: "0005.HK" }),
        searchParams: Promise.resolve({ run: "7" }),
      }),
    );
    expect(screen.getByText("api: unreachable")).toBeInTheDocument();
  });

  it("renders a not-found state when the deep-dive 404s", async () => {
    stubFetch((url) =>
      url.includes("/reports/deep-dive") ? { status: 404, ok: false } : ok(priceHistoryFixture),
    );
    render(
      await SymbolPage({
        params: Promise.resolve({ symbol: "XXXX" }),
        searchParams: Promise.resolve({ run: "7" }),
      }),
    );
    expect(screen.getByText(/no deep-dive found for XXXX in run 7/)).toBeInTheDocument();
  });

  it("renders a no-verdict card for failed deep-dives", async () => {
    stubFetch((url) =>
      url.includes("/reports/deep-dive")
        ? ok({ ...deepDiveFixture, status: "failed:parse-error", verdict: null })
        : ok(priceHistoryFixture),
    );
    render(
      await SymbolPage({
        params: Promise.resolve({ symbol: "0005.HK" }),
        searchParams: Promise.resolve({ run: "7" }),
      }),
    );
    expect(screen.getByTestId("verdict-card")).toHaveTextContent(
      "no verdict — deep-dive failed:parse-error",
    );
  });

  it("lists only runs containing this symbol in the picker (symbol filter)", async () => {
    const symbolRuns: RunSummary[] = [
      { id: 7, runAt: "2026-09-06T08:00:00.000Z", market: "HK", screenRunId: 12, topN: 2, llmCalls: 12, cacheHits: 2, failed: 0 },
    ];
    stubFetch((url) =>
      url.includes("/reports/deep-dive")
        ? ok(deepDiveFixture)
        : url.includes("/reports/runs")
          ? ok(symbolRuns)
          : ok(priceHistoryFixture),
    );
    render(
      await SymbolPage({
        params: Promise.resolve({ symbol: "0005.HK" }),
        searchParams: Promise.resolve({ run: "7" }),
      }),
    );
    const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("http://api.test/reports/runs?symbol=0005.HK");
    expect(screen.getByTestId("run-picker")).toHaveTextContent("param:run");
    expect(screen.getByTestId("run-picker")).toHaveTextContent("current:7");
    expect(screen.getByTestId("run-picker")).toHaveTextContent("runs:7");
  });

  it("passes price-history indicators through to the chart", async () => {
    stubFetch((url) =>
      url.includes("/reports/deep-dive")
        ? ok(deepDiveFixture)
        : url.includes("/reports/runs")
          ? ok([])
          : ok({
              ...priceHistoryFixture,
              indicators: { sma50: [{ date: "2026-09-01", value: 97 }], sma200: [], mom20: [], mom60: [], mdd252: [], vol60: [] },
            }),
    );
    render(
      await SymbolPage({
        params: Promise.resolve({ symbol: "0005.HK" }),
        searchParams: Promise.resolve({ run: "7" }),
      }),
    );
    expect(screen.getByTestId("price-chart")).toHaveTextContent("sma50:1");
  });

  it("offers the picker on the no-deep-dive notice so the user can switch runs", async () => {
    const symbolRuns: RunSummary[] = [
      { id: 9, runAt: "2026-09-07T08:00:00.000Z", market: "HK", screenRunId: 13, topN: 2, llmCalls: 9, cacheHits: 0, failed: 0 },
    ];
    stubFetch((url) =>
      url.includes("/reports/deep-dive")
        ? { status: 404, ok: false }
        : url.includes("/reports/runs")
          ? ok(symbolRuns)
          : ok(priceHistoryFixture),
    );
    render(
      await SymbolPage({
        params: Promise.resolve({ symbol: "XXXX" }),
        searchParams: Promise.resolve({ run: "7" }),
      }),
    );
    expect(screen.getByText(/no deep-dive found for XXXX in run 7/)).toBeInTheDocument();
    expect(screen.getByTestId("run-picker")).toHaveTextContent("runs:9");
  });
});
