import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "@/app/page";
import { dailyReportFixture } from "./fixtures";

// Page nests the async server component ApiHealth — stub it (its own tests
// live in api-health.test.tsx).
vi.mock("@/app/api-health", () => ({
  ApiHealth: () => <p data-testid="api-health">api: stubbed</p>,
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
      url.includes("/reports/daily") ? ok({ ...dailyReportFixture, market: url.includes("US") ? "US" : "HK" }) : ok({}),
    );
    render(await Page());
    expect(screen.getByRole("heading", { name: "agentic-trading — daily report" })).toBeInTheDocument();
    expect(screen.getByTestId("lane-HK")).toHaveTextContent("0005.HK");
    expect(screen.getByTestId("lane-US")).toHaveTextContent("0005.HK");
    expect(screen.getAllByTestId("degraded-banner")).toHaveLength(2);
    expect(screen.getByTestId("api-health")).toHaveTextContent("api: stubbed");
  });

  it("renders per-lane api:unreachable notices when the api is down", async () => {
    stubFetch(() => new Error("connection refused"));
    render(await Page());
    expect(screen.getByTestId("lane-HK")).toHaveTextContent("api: unreachable");
    expect(screen.getByTestId("lane-US")).toHaveTextContent("api: unreachable");
  });

  it("renders a no-run empty state per lane on 404, independent of the other lane", async () => {
    stubFetch((url) =>
      url.includes("market=HK")
        ? ok(dailyReportFixture)
        : { status: 404, ok: false },
    );
    render(await Page());
    expect(screen.getByTestId("lane-HK")).toHaveTextContent("0005.HK");
    expect(screen.getByTestId("lane-US")).toHaveTextContent("no run yet for US");
  });
});
