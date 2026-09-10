import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// PriceChart is canvas-backed; stub it (its own tests live in price-chart.test.tsx).
vi.mock("@/app/components/price-chart", () => ({
  PriceChart: (props: { bars: unknown[]; markers: unknown[]; indicators?: { sma50: unknown[] } }) => (
    <div data-testid="price-chart">
      bars:{props.bars.length} markers:{props.markers.length}
      {props.indicators ? ` sma50:${props.indicators.sma50.length}` : " no-indicators"}
    </div>
  ),
}));

import { ChatApp } from "@/app/chat/chat-app";
import { ToolCard, parseToolData } from "@/app/chat/tool-cards";
import { deepDiveIndexFixture, sessionDetailFixture, sessionSummaryFixture, toolData } from "./fixtures";

describe("parseToolData", () => {
  it("extracts name and JSON from the <tool-data> wrapper", () => {
    expect(parseToolData(toolData("listRuns", [{ id: 7 }]))).toEqual({ name: "listRuns", data: [{ id: 7 }] });
  });

  it("returns null for unwrapped or malformed payloads", () => {
    expect(parseToolData("plain text")).toBeNull();
    expect(parseToolData('<tool-data name="x">{bad json</tool-data>')).toBeNull();
  });
});

describe("ToolCard edge cases", () => {
  it("renders a no-verdict deep-dive card when verdict is null", () => {
    render(
      <ToolCard
        toolName="getDeepDive"
        content={toolData("getDeepDive", { ...deepDiveIndexFixture, status: "failed:parse-error", verdict: null })}
      />,
    );
    expect(screen.getByTestId("tool-card-deepdive")).toHaveTextContent("no verdict — deep-dive failed:parse-error");
  });

  it("renders a raw details card for a parseable payload with an unknown tool name", () => {
    render(<ToolCard toolName="someFutureTool" content={toolData("someFutureTool", { a: 1 })} />);
    const raw = screen.getByTestId("tool-card-raw");
    expect(raw).toHaveTextContent("someFutureTool (raw)");
    expect(raw).toHaveTextContent('"a": 1');
  });

  it("falls back to the message's toolName when the wrapper is missing", () => {
    render(<ToolCard toolName="weirdTool" content="garbage" />);
    expect(screen.getByTestId("tool-card-raw")).toHaveTextContent("weirdTool (raw)");
  });

  it("getPriceHistory card passes indicators through to the chart (phase 3c)", () => {
    const payload = {
      symbol: "0005.HK",
      days: 250,
      bars: [{ date: "2026-09-01", close: 98.02, volume: 1000 }],
      markers: [],
      indicators: {
        sma50: [{ date: "2026-09-01", value: 97 }],
        sma200: [],
        mom20: [],
        mom60: [],
        mdd252: [],
        vol60: [],
      },
    };
    render(<ToolCard toolName="getPriceHistory" content={toolData("getPriceHistory", payload)} />);
    expect(screen.getByTestId("price-chart")).toHaveTextContent("sma50:1");
  });

  it("getPriceHistory card renders without indicators (pre-3c persisted payloads)", () => {
    const payload = {
      symbol: "0005.HK",
      days: 250,
      bars: [{ date: "2026-09-01", close: 98.02, volume: 1000 }],
      markers: [],
    };
    render(<ToolCard toolName="getPriceHistory" content={toolData("getPriceHistory", payload)} />);
    expect(screen.getByTestId("price-chart")).toHaveTextContent("no-indicators");
  });
});

describe("chat message list (resumed session)", () => {
  it("renders user/assistant messages and one tool card per tool name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/chat/sessions") return new Response(JSON.stringify([sessionSummaryFixture]), { status: 200 });
        if (url === "/api/chat/sessions/1") return new Response(JSON.stringify(sessionDetailFixture), { status: 200 });
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const { findByTestId, unmount } = render(<ChatApp />);
    // wait for the session list, then open the session
    const item = await findByTestId("session-list");
    item.querySelector("button")!.click();

    const list = await findByTestId("message-list");
    expect(list).toHaveTextContent("what moved today?");
    expect(screen.getByTestId("msg-assistant")).toHaveTextContent("HSBC");

    expect(screen.getByTestId("tool-card-daily")).toBeInTheDocument();
    expect(screen.getByTestId("tool-card-daily")).toHaveTextContent("0005.HK");

    const dd = screen.getByTestId("tool-card-deepdive");
    expect(dd).toHaveTextContent("solid momentum");
    expect(dd.querySelector('[data-testid="rating-badge"]')).toHaveTextContent("buy");
    expect(dd).toHaveTextContent("transcript index (1 entries)");

    expect(screen.getByTestId("tool-card-price")).toHaveTextContent("bars:2 markers:1");

    const cmp = screen.getByTestId("tool-card-compare");
    expect(cmp).toHaveTextContent("0700.HK");
    expect(cmp).toHaveTextContent("no verdict");

    expect(screen.getByTestId("tool-card-runs")).toHaveTextContent("HK");

    expect(screen.getByTestId("tool-card-transcript")).toHaveTextContent("resp");

    // unparseable tool payload degrades to collapsed raw details
    expect(screen.getByTestId("tool-card-raw")).toHaveTextContent("not wrapped, not json");

    // cost header reflects the session totals
    expect(screen.getByTestId("cost-header")).toHaveTextContent("calls: 2/20 · tokens: 120+45");
    unmount();
    vi.unstubAllGlobals();
  });
});
