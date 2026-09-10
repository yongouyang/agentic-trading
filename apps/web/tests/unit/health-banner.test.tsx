import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthBanner } from "@/app/components/health-banner";
import type { HealthReport } from "@/app/types";

/**
 * W4d (docs/ops-hardening-plan.md). The banner is the only thing that surfaces
 * a dead run or a quiet lane — launchd's non-zero exit tells nobody.
 */
const healthy: HealthReport = {
  asOf: "2026-09-10T15:00:00.000Z",
  level: "healthy",
  lanes: [
    {
      market: "HK",
      level: "healthy",
      reasons: [],
      lastCompleteRunId: 6,
      lastCompleteRunAt: "2026-09-10T08:50:00.000Z",
      lastScreenRunId: 15,
      dataThrough: "2026-09-10",
      expectedRunsMissed: 0,
      staleRunning: null,
    },
  ],
  jobs: [{ job: "sentinel", level: "healthy", reasons: [], lastArtifactDate: "2026-09-06" }],
};

const usAlert: HealthReport = {
  ...healthy,
  level: "alert",
  lanes: [
    {
      market: "US",
      level: "alert",
      reasons: ["3 scheduled runs missed since the last complete run (2026-09-06T13:16:11.989Z)"],
      lastCompleteRunId: 3,
      lastCompleteRunAt: "2026-09-06T13:16:11.989Z",
      lastScreenRunId: 15,
      dataThrough: "2026-09-08",
      expectedRunsMissed: 3,
      staleRunning: null,
    },
  ],
};

describe("HealthBanner", () => {
  it("renders nothing when the pipeline is healthy", () => {
    render(<HealthBanner health={healthy} />);
    expect(screen.queryByTestId("health-banner")).not.toBeInTheDocument();
  });

  it("flags an alert lane with its data cutoff and missed-run count", () => {
    render(<HealthBanner health={usAlert} />);
    const banner = screen.getByTestId("health-banner");
    expect(banner).toHaveClass("banner-health-alert");
    expect(banner).toHaveTextContent("pipeline alert");
    expect(banner).toHaveTextContent("US");
    expect(banner).toHaveTextContent("data through 2026-09-08");
    expect(banner).toHaveTextContent("3 scheduled run(s) missed");
  });

  it("renders a warn lane with the amber class, not the red one", () => {
    const warn: HealthReport = {
      ...healthy,
      level: "warn",
      lanes: [{ ...healthy.lanes[0]!, level: "warn", reasons: ["1 scheduled run is currently late (catch-up pending)"], expectedRunsMissed: 1 }],
    };
    render(<HealthBanner health={warn} />);
    const banner = screen.getByTestId("health-banner");
    expect(banner).toHaveClass("banner-health-warn");
    expect(banner).toHaveTextContent("catch-up pending");
  });

  it("shows a lane that has never completed a run without inventing numbers", () => {
    const noRun: HealthReport = {
      ...healthy,
      level: "alert",
      lanes: [
        {
          market: "US",
          level: "alert",
          reasons: ["no complete deep-dive run on record"],
          lastCompleteRunId: null,
          lastCompleteRunAt: null,
          lastScreenRunId: null,
          dataThrough: null,
          expectedRunsMissed: 30,
          staleRunning: null,
        },
      ],
    };
    render(<HealthBanner health={noRun} />);
    const banner = screen.getByTestId("health-banner");
    expect(banner).toHaveTextContent("no complete run");
    expect(banner).toHaveTextContent("data through —");
  });

  it("lists an overdue weekly job", () => {
    const jobAlert: HealthReport = {
      ...healthy,
      level: "alert",
      lanes: [],
      jobs: [{ job: "f10", level: "alert", reasons: ["no f10-refresh-<date>.json artifact on record — cannot confirm the weekly job ran"], lastArtifactDate: null }],
    };
    render(<HealthBanner health={jobAlert} />);
    const banner = screen.getByTestId("health-banner");
    expect(banner).toHaveTextContent("f10");
    expect(banner).toHaveTextContent("none on record");
    expect(banner).toHaveTextContent("cannot confirm");
  });

  it("an unreachable api renders the quiet line rather than shouting", () => {
    render(<HealthBanner health={null} />);
    const banner = screen.getByTestId("health-banner");
    expect(banner).toHaveTextContent("pipeline health: unreachable");
    expect(banner).not.toHaveClass("banner-health-alert");
  });
});
