import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "@/app/page";
import { dailyReportFixture } from "./fixtures";
import type { RunSummary } from "@/app/types";

// Page nests the async server component ApiHealth — stub it (its own tests
// live in api-health.test.tsx). RunPicker is a client component (its own
// tests live in run-picker.test.tsx); stub it to capture the wiring props.
vi.mock("@/app/api-health", () => ({
  ApiHealth: () => <p data-testid="api-health">api: stubbed</p>,
}));
vi.mock("@/app/components/run-picker", () => ({
  RunPicker: (props: { runs: RunSummary[]; param: string; current?: number; testId?: string }) => (
    <div data-testid={props.testId ?? "run-picker"}>
      param:{props.param} current:{props.current ?? "latest"} runs:{props.runs.map((r) => r.id).join(",")}
    </div>
  ),
}));

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

const noSearch = { searchParams: Promise.resolve({}) };

const runsFixture: RunSummary[] = [
  { id: 9, runAt: "2026-09-07T10:00:00.000Z", market: "HK", screenRunId: 20, topN: 3, llmCalls: 8, cacheHits: 1, failed: 1 },
  { id: 7, runAt: "2026-09-06T08:00:00.000Z", market: "HK", screenRunId: 12, topN: 2, llmCalls: 12, cacheHits: 2, failed: 1 },
];

describe("dashboard page", () => {
  beforeEach(() => {
    vi.stubEnv("API_INTERNAL_URL", "http://api.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders both lanes with the watchlist when the api serves reports", async () => {
    stubFetch((url) =>
      url.includes("/reports/daily") ? ok({ ...dailyReportFixture, market: url.includes("US") ? "US" : "HK" }) : ok([]),
    );
    render(await Page(noSearch));
    expect(screen.getByRole("heading", { name: "agentic-trading — daily report" })).toBeInTheDocument();
    expect(screen.getByTestId("lane-HK")).toHaveTextContent("0005.HK");
    expect(screen.getByTestId("lane-US")).toHaveTextContent("0005.HK");
    expect(screen.getAllByTestId("degraded-banner")).toHaveLength(2);
    expect(screen.getByTestId("api-health")).toHaveTextContent("api: stubbed");
  });

  it("renders per-lane api:unreachable notices when the api is down", async () => {
    stubFetch(() => new Error("connection refused"));
    render(await Page(noSearch));
    expect(screen.getByTestId("lane-HK")).toHaveTextContent("api: unreachable");
    expect(screen.getByTestId("lane-US")).toHaveTextContent("api: unreachable");
  });

  it("renders a no-run empty state per lane on 404, independent of the other lane", async () => {
    stubFetch((url) =>
      url.includes("market=HK")
        ? ok(dailyReportFixture)
        : url.includes("/reports/runs")
          ? ok([])
          : { status: 404, ok: false },
    );
    render(await Page(noSearch));
    expect(screen.getByTestId("lane-HK")).toHaveTextContent("0005.HK");
    expect(screen.getByTestId("lane-US")).toHaveTextContent("no run yet for US");
  });

  it("wires a per-lane run picker from /reports/runs, latest by default", async () => {
    stubFetch((url) =>
      url.includes("/reports/runs")
        ? ok(runsFixture.map((r) => ({ ...r, market: url.includes("US") ? "US" : "HK" })))
        : ok({ ...dailyReportFixture, market: url.includes("US") ? "US" : "HK" }),
    );
    render(await Page(noSearch));
    expect(screen.getByTestId("run-picker-HK")).toHaveTextContent("param:hkRun");
    expect(screen.getByTestId("run-picker-HK")).toHaveTextContent("current:latest");
    expect(screen.getByTestId("run-picker-HK")).toHaveTextContent("runs:9,7");
    expect(screen.getByTestId("run-picker-US")).toHaveTextContent("param:usRun");
    expect(screen.getByTestId("run-picker-US")).toHaveTextContent("runs:9,7");
  });

  it("passes ?hkRun/?usRun through to the daily fetch and reflects them in the pickers", async () => {
    stubFetch((url) =>
      url.includes("/reports/runs")
        ? ok(runsFixture)
        : ok({ ...dailyReportFixture, market: url.includes("US") ? "US" : "HK" }),
    );
    render(await Page({ searchParams: Promise.resolve({ hkRun: "7", usRun: "9" }) }));
    const urls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("http://api.test/reports/daily?market=HK&runId=7");
    expect(urls).toContain("http://api.test/reports/daily?market=US&runId=9");
    expect(screen.getByTestId("run-picker-HK")).toHaveTextContent("current:7");
    expect(screen.getByTestId("run-picker-US")).toHaveTextContent("current:9");
  });

  it("omits the picker when the runs fetch fails but keeps the lane", async () => {
    stubFetch((url) =>
      url.includes("/reports/runs") ? new Error("down") : ok(dailyReportFixture),
    );
    render(await Page(noSearch));
    // Stubbed RunPicker still renders for empty runs; the real component
    // returns null (tested in run-picker.test.tsx). Assert the wiring: empty.
    expect(screen.getByTestId("run-picker-HK")).toHaveTextContent("runs:");
    expect(screen.getByTestId("lane-HK")).toHaveTextContent("0005.HK");
  });
});
