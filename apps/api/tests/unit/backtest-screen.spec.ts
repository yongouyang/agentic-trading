/**
 * `backtest:screen`'s production-vs-replay audit: the stored census candidate
 * must be a CHAIN row. A rescreen row's census is the replay's own output
 * recomputed from the store — comparing against it would trivially "match" and
 * prove nothing (2026-09-13).
 */
import { describe, expect, it } from "vitest";
import { auditAgainstProduction } from "../../src/cli/backtest-screen.js";
import type { ReplayDay } from "@agentic-trading/quant-core";

const replayDays: ReplayDay[] = [
  {
    date: "2026-09-09",
    ranked: [],
    excludedCount: 1,
    excludedByReason: { US: { LOW_LIQUIDITY: 1 }, HK: {} },
    excludedMarginal: { US: { LOW_LIQUIDITY: 1 }, HK: {} },
    excludedSole: { US: { LOW_LIQUIDITY: 1 }, HK: {} },
  },
  {
    date: "2026-09-11",
    ranked: [],
    excludedCount: 2,
    excludedByReason: { US: { HIGH_VOLATILITY: 2 }, HK: {} },
    excludedMarginal: { US: { HIGH_VOLATILITY: 2 }, HK: {} },
    excludedSole: { US: { HIGH_VOLATILITY: 2 }, HK: {} },
  },
];

const stub = (runs: any[]) => ({ screenRun: { findMany: async () => runs } }) as any;

describe("auditAgainstProduction — prefers the chain census over a rescreen's", () => {
  it("skips a newer-by-runAt rescreen row and compares against the chain row's session", async () => {
    const audit = await auditAgainstProduction(
      stub([
        // Newest first (the query orders runAt desc): the rescreen row sits on top.
        { id: 30, runAt: new Date("2026-09-13T02:00:00Z"), source: "rescreen", sessionDate: "2026-09-09", excludedJson: '{"LOW_LIQUIDITY":1}', ok: 0 },
        { id: 29, runAt: new Date("2026-09-12T06:15:00Z"), source: "chain", sessionDate: "2026-09-11", excludedJson: '{"HIGH_VOLATILITY":2}', ok: 180 },
      ]),
      "US",
      replayDays,
    );
    expect(audit).not.toBeNull();
    expect(audit!.screenRunId).toBe(29);
    expect(audit!.date).toBe("2026-09-11"); // the chain row's session, not hktDate(runAt)
    expect(audit!.status).toBe("match");
    expect(audit!.stored).toEqual({ HIGH_VOLATILITY: 2 });
  });

  it("a pre-column row (no source) reads as chain, matching the provenance-gate doctrine", async () => {
    const audit = await auditAgainstProduction(
      stub([
        { id: 30, runAt: new Date("2026-09-13T02:00:00Z"), source: "rescreen", sessionDate: "2026-09-09", excludedJson: '{"LOW_LIQUIDITY":1}', ok: 0 },
        { id: 28, runAt: new Date("2026-09-11T20:40:00Z"), sessionDate: "2026-09-11", excludedJson: '{"HIGH_VOLATILITY":2}', ok: 180 },
      ]),
      "US",
      replayDays,
    );
    expect(audit!.screenRunId).toBe(28);
    expect(audit!.status).toBe("match");
  });

  it("falls back to a rescreen row when no chain census exists — honest, not preferred", async () => {
    const audit = await auditAgainstProduction(
      stub([{ id: 30, runAt: new Date("2026-09-13T02:00:00Z"), source: "rescreen", sessionDate: "2026-09-09", excludedJson: '{"LOW_LIQUIDITY":1}', ok: 0 }]),
      "US",
      replayDays,
    );
    expect(audit!.screenRunId).toBe(30);
    expect(audit!.date).toBe("2026-09-09"); // sessionDate, never the rescreen's runAt day
    expect(audit!.status).toBe("match");
  });

  it("no census anywhere ⇒ no-stored-census against the newest run", async () => {
    const audit = await auditAgainstProduction(
      stub([{ id: 7, runAt: new Date("2026-09-11T20:40:00Z"), sessionDate: "2026-09-11", excludedJson: "{}", ok: 5 }]),
      "US",
      replayDays,
    );
    expect(audit!.status).toBe("no-stored-census");
    expect(audit!.screenRunId).toBe(7);
  });
});
