import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LaneSection } from "@/app/components/lane-section";
import { WatchlistTable } from "@/app/components/watchlist-table";
import { dailyReportFixture } from "./fixtures";

describe("WatchlistTable", () => {
  it("renders rows with rating, conviction, and links to the detail page", () => {
    render(<WatchlistTable rows={dailyReportFixture.rows} runId={7} />);
    expect(screen.getAllByTestId("rating-badge")).toHaveLength(4);
    expect(screen.getByRole("link", { name: "0005.HK" })).toHaveAttribute(
      "href",
      "/symbol/0005.HK?run=7",
    );
    expect(screen.getByText("solid momentum")).toBeInTheDocument();
    expect(screen.getByText("0.90")).toBeInTheDocument();
  });

  it("renders a null verdict row (rank > topN) with an em-dash", () => {
    render(<WatchlistTable rows={dailyReportFixture.rows} runId={7} />);
    expect(screen.getByText("not deep-dived")).toBeInTheDocument();
  });

  it("renders a failed deep-dive row with the failure slug", () => {
    render(<WatchlistTable rows={dailyReportFixture.rows} runId={7} />);
    expect(screen.getByText("deep-dive failed (parse-error)")).toBeInTheDocument();
  });

  it("marks CA-degraded names", () => {
    render(<WatchlistTable rows={dailyReportFixture.rows} runId={7} />);
    expect(screen.getByTitle("corporate-action degraded")).toBeInTheDocument();
  });
});

describe("lane header — measurement vs display breadth (Phase 5 Fork A)", () => {
  it("states the displayed count and the deep-dived count separately", () => {
    // They now differ on purpose (40 deep-dived, 10 shown), so a header printing
    // only `run.topN` would present the sample as if it were the list.
    const result = {
      kind: "ok" as const,
      report: {
        market: "US" as const,
        run: { id: 7, runAt: "2026-09-11T06:10:00.000Z", screenRunId: 16, topN: 40, llmCalls: 300, cacheHits: 0, failed: 0, warnings: [] },
        integrity: {
          universeSize: 555,
          ok: 555,
          genuinelyAbsent: 0,
          fetchFailed: 0,
          degraded: false,
          warnings: [],
          dataThrough: "2026-09-10",
          caveat: "unvalidated",
        },
        rows: [
          { rank: 1, symbol: "AAPL", market: "US" as const, score: 1, verdict: null, metrics: {} },
          { rank: 2, symbol: "MSFT", market: "US" as const, score: 0.9, verdict: null, metrics: {} },
        ],
      },
    };
    render(<LaneSection market="US" result={result as never} />);
    expect(screen.getByText(/showing 2 of 40 deep-dived/)).toBeInTheDocument();
  });
});
