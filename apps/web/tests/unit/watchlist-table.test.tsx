import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
