import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunSummary } from "@/app/types";

const push = vi.fn();
let currentParams = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(currentParams),
}));

import { RunPicker } from "@/app/components/run-picker";

const runs: RunSummary[] = [
  { id: 9, runAt: "2026-09-07T10:00:00.000Z", market: "US", screenRunId: 20, topN: 3, llmCalls: 8, cacheHits: 1, failed: 1 },
  { id: 7, runAt: "2026-09-06T10:00:00.000Z", market: "US", screenRunId: 18, topN: 2, llmCalls: 12, cacheHits: 2, failed: 0 },
];

describe("RunPicker", () => {
  afterEach(() => {
    push.mockClear();
    currentParams = "";
  });

  it("renders runs newest-first with the locked label format", () => {
    render(<RunPicker runs={runs} param="usRun" />);
    const options = screen.getByTestId("run-picker").querySelectorAll("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent("latest run");
    expect(options[1]).toHaveTextContent(/^run 9 · .+ · topN 3$/);
    expect(options[2]).toHaveTextContent(/^run 7 · .+ · topN 2$/);
  });

  it("navigates with the run id in the URL on select, preserving other params", () => {
    currentParams = "hkRun=4";
    render(<RunPicker runs={runs} param="usRun" />);
    fireEvent.change(screen.getByTestId("run-picker"), { target: { value: "7" } });
    expect(push).toHaveBeenCalledTimes(1);
    const url = new URL(push.mock.calls[0]![0] as string, "http://x.test");
    expect(url.searchParams.get("hkRun")).toBe("4");
    expect(url.searchParams.get("usRun")).toBe("7");
  });

  it("selecting 'latest run' removes the param", () => {
    currentParams = "hkRun=4&usRun=7";
    render(<RunPicker runs={runs} param="usRun" current={7} />);
    fireEvent.change(screen.getByTestId("run-picker"), { target: { value: "" } });
    const url = new URL(push.mock.calls[0]![0] as string, "http://x.test");
    expect(url.searchParams.get("usRun")).toBeNull();
    expect(url.searchParams.get("hkRun")).toBe("4");
  });

  it("navigates to the bare pathname when the removed param was the last one", () => {
    currentParams = "usRun=7";
    render(<RunPicker runs={runs} param="usRun" current={7} />);
    fireEvent.change(screen.getByTestId("run-picker"), { target: { value: "" } });
    expect(push).toHaveBeenCalledWith("/");
  });

  it("reflects the current selection", () => {
    currentParams = "usRun=7";
    render(<RunPicker runs={runs} param="usRun" current={7} />);
    expect(screen.getByTestId("run-picker")).toHaveValue("7");
  });

  it("renders nothing when there are no runs", () => {
    const { container } = render(<RunPicker runs={[]} param="usRun" />);
    expect(container).toBeEmptyDOMElement();
  });
});
