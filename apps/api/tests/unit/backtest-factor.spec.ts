/**
 * Phase 6A A5 — the sweep's decisions, tested where they are decidable.
 *
 * The label rule is the one piece of this CLI that converts measurements into a
 * claim, so it is tested exhaustively over its three clauses: a statistically
 * clean alpha below the lane's detection floor must still be `dead`, and a large
 * IC that no FDR correction leaves standing must also be `dead`.
 */
import { describe, expect, it } from "vitest";
import {
  FDR_Q,
  POWER_FLOOR,
  PRIMARY_HORIZON,
  PROMOTION_K,
  applyFdr,
  alphaRow,
  labelFor,
  parseFactorArgs,
  renderFactor,
  type AlphaRow,
  type FactorReport,
  type LaneReport,
} from "../../src/cli/backtest-factor.js";
import { daysFromSignals, forwardFromPanel, type MaskMatrix, type NumberMatrix } from "@agentic-trading/quant-core";

describe("parseFactorArgs", () => {
  it("defaults to both lanes, both universes, and every available alpha", () => {
    expect(parseFactorArgs([])).toEqual({
      markets: ["US", "HK"],
      alphas: null,
      universes: ["U1", "U2"],
      panel: null,
      from: null,
      to: null,
      quiet: false,
    });
  });

  it("accepts pnpm's bare -- and ignores --json", () => {
    const a = parseFactorArgs(["--", "--json", "--market", "us", "--quiet"]);
    expect(a.markets).toEqual(["US"]);
    expect(a.quiet).toBe(true);
  });

  it("parses the universe, alpha list, panel and date range", () => {
    const a = parseFactorArgs(["--universe", "u1", "--alpha", "a_1,b_2", "--panel", "/tmp/p", "--from", "2023-01-01", "--to", "2024-01-01"]);
    expect(a.universes).toEqual(["U1"]);
    expect(a.alphas).toEqual(["a_1", "b_2"]);
    expect(a.panel).toBe("/tmp/p");
    expect(a.from).toBe("2023-01-01");
    expect(a.to).toBe("2024-01-01");
    expect(parseFactorArgs(["--universe", "both"]).universes).toEqual(["U1", "U2"]);
  });

  it("rejects a bad enum or a malformed date rather than silently defaulting", () => {
    expect(() => parseFactorArgs(["--market", "jp"])).toThrow(/us\|hk\|all/);
    expect(() => parseFactorArgs(["--universe", "u3"])).toThrow(/u1\|u2\|both/);
    expect(() => parseFactorArgs(["--from", "2023/01/01"])).toThrow(/YYYY-MM-DD/);
    expect(() => parseFactorArgs(["--nope"])).toThrow(/unknown argument/);
  });
});

describe("the label rule", () => {
  it("needs all three clauses: sign, FDR survival, and the lane's power floor", () => {
    expect(labelFor(0.05, true, 0.0297)).toBe("alive");
    expect(labelFor(-0.05, true, 0.0297)).toBe("reversed");
    // Below the floor the lane could not have detected the effect, so a clean
    // significant IC of 0.02 on the US lane is UNINFORMATIVE, not evidence.
    expect(labelFor(0.02, true, 0.0297)).toBe("dead");
    expect(labelFor(-0.02, true, 0.0297)).toBe("dead");
    // Above the floor but not an FDR survivor: the search explains it.
    expect(labelFor(0.05, false, 0.0297)).toBe("dead");
    expect(labelFor(-0.05, false, 0.0297)).toBe("dead");
  });

  it("treats the floor as inclusive and a zero IC as dead", () => {
    expect(labelFor(POWER_FLOOR.US, true, POWER_FLOOR.US)).toBe("alive");
    expect(labelFor(0, true, POWER_FLOOR.US)).toBe("dead");
    expect(labelFor(-POWER_FLOOR.HK, true, POWER_FLOOR.HK)).toBe("reversed");
  });
});

describe("applyFdr", () => {
  const row = (id: string, p: number | null, meanIc: number): AlphaRow =>
    ({ id, p, meanIc, universe: "U1", label: "dead", fdrReject: false, fdrAdjusted: null, clearedFloor: false }) as AlphaRow;

  it("stamps the FDR decision and the label onto the rows in place", () => {
    const rows = [row("a", 0.0001, 0.08), row("b", 0.5, 0.05), row("c", 0.0002, -0.09), row("d", null, 0.2)];
    const { discoveries, k } = applyFdr(rows, FDR_Q, POWER_FLOOR.US);
    expect(k).toBe(3); // the null p is excluded, not counted as p = 1
    expect(discoveries).toBe(2);
    expect(rows[0]!.label).toBe("alive");
    expect(rows[2]!.label).toBe("reversed");
    expect(rows[1]!.label).toBe("dead");
    expect(rows[3]!.fdrAdjusted).toBeNull();
    expect(rows[3]!.fdrReject).toBe(false);
    expect(rows[3]!.label).toBe("dead");
  });

  it("is monotone in q: a looser level can only add survivors", () => {
    const build = () => [row("a", 0.004, 0.05), row("b", 0.02, 0.05), row("c", 0.03, 0.05), row("d", 0.04, 0.05)];
    const tight = build();
    applyFdr(tight, 0.01, POWER_FLOOR.US);
    const loose = build();
    applyFdr(loose, 0.2, POWER_FLOOR.US);
    expect(loose.filter((r) => r.fdrReject).length).toBeGreaterThanOrEqual(tight.filter((r) => r.fdrReject).length);
  });

  it("records clearedFloor separately from the label, so the gating clause is auditable", () => {
    const rows = [row("big", 0.0001, 0.5), row("small", 0.0001, 0.001)];
    applyFdr(rows, FDR_Q, POWER_FLOOR.US);
    expect(rows[0]!.clearedFloor).toBe(true);
    expect(rows[1]!.clearedFloor).toBe(false);
    expect(rows[1]!.fdrReject).toBe(true); // statistically clean…
    expect(rows[1]!.label).toBe("dead"); // …and still uninformative at this breadth
  });
});

describe("alphaRow on a synthetic panel", () => {
  const dates = Array.from({ length: 80 }, (_, i) => `2024-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`);
  const symbols = ["A", "B", "C", "D", "E", "F"];
  const f = (d: number, s: number) => 100 * Math.exp(0.004 * (s + 1) * d + 0.03 * Math.sin(d * 0.5 + s));
  const close: NumberMatrix = { dates, symbols, values: dates.map((_, d) => symbols.map((__, s) => f(d, s))) };
  const mask: MaskMatrix = { dates, symbols, values: dates.map(() => symbols.map(() => 2 as const)) };
  const forward = forwardFromPanel(close);

  it("computes the 20d statistic and reports 5/20/60 alongside it", () => {
    // A REALISTIC signal (trailing 20-session return plus deterministic
    // cross-sectional noise), not the exact label and not a clean monotone
    // function of the drift: a signal whose IC is CONSTANT every day has zero
    // variance in the IC series, so no Newey-West SE exists and no row can be
    // reported — see the next test, which pins that behaviour down.
    const trailing = (d: number, s: number) => close.values[d]![s]! / (close.values[d - PRIMARY_HORIZON]?.[s] ?? close.values[d]![s]!) - 1;
    const signals: NumberMatrix = {
      dates,
      symbols,
      values: dates.map((_, d) => symbols.map((__, s) => (d < PRIMARY_HORIZON ? null : trailing(d, s) + 0.05 * Math.sin(d * 1.7 + s * 2.3)))),
    };
    const days = daysFromSignals({ signals, mask, universe: "U2" });
    const row = alphaRow("x", "U2", days, forward, { firstEvaluableSession: dates[0]!, declaredMinWarmupBars: 5 })!;
    expect(row).not.toBeNull();
    expect(row.sd).toBeGreaterThan(0); // the non-degeneracy that makes a row possible
    expect(row.meanIc).toBeGreaterThanOrEqual(-1);
    expect(row.meanIc).toBeLessThanOrEqual(1);
    expect(Number.isFinite(row.nwT)).toBe(true);
    // Two warmups stack, and this is where the plan's "an alpha's own
    // min_warmup_bars is honoured on top" becomes arithmetically visible: the
    // signal needs 20 sessions before it exists, and the 20d label needs 20 more
    // before it exists, so 80 sessions yield 40 evaluable days.
    expect(PRIMARY_HORIZON).toBe(20);
    expect(row.days).toBe(dates.length - 2 * PRIMARY_HORIZON);
    // A shorter horizon keeps more days, which is exactly why 20d decides and the
    // 5d/60d rows may not override it.
    expect(row.horizons.find((h) => h.horizon === 5)!.days).toBeGreaterThan(row.days);
    expect(row.horizons.find((h) => h.horizon === 60)!.days).toBeLessThan(row.days);
    expect(row.meanBreadth).toBe(6);
    expect(row.lag).toBe(PRIMARY_HORIZON);
    expect(row.horizons.map((h) => h.horizon)).toEqual([5, 20, 60]);
    expect(row.byYear.length).toBeGreaterThan(0);
    expect(row.declaredMinWarmupBars).toBe(5);
    expect(row.label).toBe("dead"); // set by applyFdr, not here
  });

  it("returns null when the IC series has no variance, because no NW SE exists", () => {
    // A signal that IS the label gives IC = +1 every day. That is a degenerate IC
    // series (sd = 0), so `neweyWestT` declines and the alpha contributes no
    // statistic — the honest outcome, and the reason a perfectly predictive alpha
    // would be reported as a missing row rather than as an infinitely good one.
    const perfect: NumberMatrix = { dates, symbols, values: dates.map((_, d) => symbols.map((__, s) => close.values[d + PRIMARY_HORIZON]?.[s]! / close.values[d]![s]! - 1)) };
    const days = daysFromSignals({ signals: perfect, mask, universe: "U2" });
    expect(alphaRow("perfect", "U2", days, forward, { firstEvaluableSession: null, declaredMinWarmupBars: null })).toBeNull();

    // And a constant signal has no cross-sectional variance at all, so Spearman is
    // undefined — dropped a step earlier, in the same honest direction.
    const flat: NumberMatrix = { dates, symbols, values: dates.map(() => symbols.map(() => 1)) };
    expect(alphaRow("flat", "U2", daysFromSignals({ signals: flat, mask, universe: "U2" }), forward, { firstEvaluableSession: null, declaredMinWarmupBars: null })).toBeNull();
  });
});

describe("rendering", () => {
  const lane = (market: "US" | "HK"): LaneReport =>
    ({
      market,
      panelDir: "/tmp/us-x",
      panelFingerprint: "fp",
      panelRange: { start: "2021-09-20", end: "2026-09-17", sessions: 1254 },
      replayWindow: { start: "2022-09-19", end: "2026-09-17", sessions: 1003 },
      window: { start: "2022-09-19", end: "2026-09-17", sessions: 1003 },
      universe: "U1",
      breadth: { meanU1: 547.7, meanU2: 180.2 },
      powerFloor: POWER_FLOOR[market],
      laneNwSe: 0.01486,
      luckBenchmarkAtLaneSe: 0.0281,
      luckBenchmarkAtSweepSe: 0.0426,
      luckBenchmarkSe: 0.02253,
      k: 6,
      fdrQ: FDR_Q,
      fdrDiscoveries: 0,
      labels: { alive: 0, reversed: 0, dead: 6 },
      rows: [],
      skipped: [],
      promotion: market === "US" ? [{ id: "academic_bab", meanIc: 0.09, label: "alive" as const }] : [],
      provenance: {},
    }) as LaneReport;
  const report: FactorReport = {
    generatedAt: "2026-09-18T00:00:00.000Z",
    primaryHorizon: PRIMARY_HORIZON,
    reportedHorizons: [5, 20, 60],
    fdrQ: FDR_Q,
    promotionK: PROMOTION_K,
    lanes: [lane("US"), lane("HK")],
  };

  it("states the statistic, both luck benchmarks, and the pre-registered limitations", () => {
    const text = renderFactor(report);
    expect(text).toContain("mean 20d rank IC with Newey-West t");
    expect(text).toContain("5d / 20d / 60d");
    expect(text).toContain("E[max|IC|]");
    expect(text).toContain("CONSERVATIVE");
    expect(text).toContain("`dead` means UNINFORMATIVE");
  });

  it("is explicit that only the US lane promotes, and that a label is not a verdict", () => {
    const text = renderFactor(report);
    expect(text).toContain("top 20 US alphas by mean IC");
    expect(text).toContain("the vendor archive is US-only, so HK can never exceed insufficient_evidence");
    expect(text).toContain("A label is a shortlist entry, not a verdict");
  });
});
