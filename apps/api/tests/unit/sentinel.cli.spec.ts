/**
 * Sentinel CLI wiring tests: the pinned sample (it IS the plan's decision —
 * an edit must be deliberate) and argument parsing.
 */
import { describe, expect, it } from "vitest";
import { parseSentinelArgs } from "../../src/cli/sentinel.js";
import { SENTINEL_HK_SAMPLE } from "../../src/sentinel/sentinel-sample.js";

describe("SENTINEL_HK_SAMPLE — pinned 10-name HK sample (plan §B, decision 3)", () => {
  it("matches the list agreed in docs/phase-1-hardening-plan.md, in order", () => {
    expect(SENTINEL_HK_SAMPLE).toEqual([
      "0005.HK",
      "0700.HK",
      "0941.HK",
      "9988.HK",
      "0388.HK",
      "0001.HK",
      "0016.HK",
      "2318.HK",
      "2800.HK",
      "3195.HK",
    ]);
  });

  it("10 unique HK names (sentinel scope is the HK lane only)", () => {
    expect(SENTINEL_HK_SAMPLE).toHaveLength(10);
    expect(new Set(SENTINEL_HK_SAMPLE).size).toBe(10);
    for (const s of SENTINEL_HK_SAMPLE) expect(s).toMatch(/^\d{4}\.HK$/);
  });
});

describe("parseSentinelArgs", () => {
  it("defaults: eastmoney leg off, pinned sample", () => {
    expect(parseSentinelArgs([])).toEqual({ eastmoney: false });
  });

  it("--eastmoney opts in to the banned cross-source leg", () => {
    expect(parseSentinelArgs(["--eastmoney"])).toEqual({ eastmoney: true });
  });

  it("--symbol is repeatable and becomes the sample override", () => {
    expect(parseSentinelArgs(["--symbol", "0005.HK", "--eastmoney", "--symbol", "2800.HK"])).toEqual({
      eastmoney: true,
      symbols: ["0005.HK", "2800.HK"],
    });
  });

  it("tolerates the bare -- that pnpm injects before script args", () => {
    expect(parseSentinelArgs(["--", "--eastmoney"])).toEqual({ eastmoney: true });
    expect(parseSentinelArgs(["--"])).toEqual({ eastmoney: false });
  });

  it("rejects a missing value and unknown arguments", () => {
    expect(() => parseSentinelArgs(["--symbol"])).toThrow(/needs a value/);
    expect(() => parseSentinelArgs(["--market", "hk"])).toThrow(/unknown argument/);
  });
});
