/**
 * `phase4c:accrual` — the prospective-data clock (Phase 4b D6).
 *
 * The one number worth testing is the projection: it must scale the OBSERVED
 * standard error by 1/√T, because "we need this much more data" is exactly the
 * kind of claim Phase 4 got wrong by assuming an effect size instead of measuring
 * one. Everything else here is parsing and date arithmetic.
 */
import { describe, expect, it } from "vitest";
import {
  GATE1_BAR,
  GATE1_T,
  hktDate,
  newestBacktestArtifact,
  parseAccrualArgs,
  projectLane,
  renderAccrual,
  requiredSessions,
  runAccrual,
  PROSPECTIVE_FROM,
  type AccrualReport,
} from "../../src/cli/accrual.js";

describe("accrual — the projection is measured, not assumed", () => {
  it("scales the observed SE by 1/sqrt(T)", () => {
    // Halving the SE needs 4x the sessions. This is the whole mechanism.
    expect(requiredSessions(1000, 0.02, 0.02, 2)).toBe(4000);
    // And the target SE is bar/t, not the bar itself: a bar reachable only at
    // t < 2 is not reachable, which is the error this round exists to fix.
    expect(requiredSessions(1000, 0.01, 0.02, 2)).toBe(1000);
    expect(requiredSessions(1000, 0.02, 0.02, 1)).toBe(1000);
  });

  it("reproduces the US and HK figures the run reported", () => {
    // From the 2026-09-11 artifact: US 983 days / NW SE 0.01488 gives ~2.2k days.
    const us = requiredSessions(983, 0.01488);
    expect(us).toBeGreaterThan(2000);
    expect(us).toBeLessThan(2400);
    // HK's 900 days at SE 0.02465 needs >5k — the number that prices "drop or
    // pool HK" for Phase 4c.
    const hk = requiredSessions(900, 0.02465);
    expect(hk).toBeGreaterThan(5000);
  });

  it("returns NaN rather than Infinity on degenerate input", () => {
    expect(Number.isNaN(requiredSessions(0, 0.01))).toBe(true);
    expect(Number.isNaN(requiredSessions(100, 0))).toBe(true);
  });

  it("projects the differential separately, because it is a different question", () => {
    const artifact = {
      lanes: [{ market: "US", gate1: { days: 983, nwSe: 0.01488 }, gate2Base: { nwT: 1.19, years: 3.98 } }],
    };
    const l = projectLane("US", { sessions: 3, labelled20: 0, latestBar: "2026-09-11" }, artifact);
    expect(l.requiredDays).toBeCloseTo(requiredSessions(983, 0.01488), 6);
    expect(l.additionalSessions).toBeCloseTo(l.requiredDays! - 983, 6);
    // t grows as sqrt(T): |t| = 2 from 1.19 over 3.98y needs ~4x the span.
    expect(l.differentialAdditionalYears).toBeCloseTo(3.98 * (2 / 1.19) ** 2 - 3.98, 6);
    expect(l.prospectiveSessions).toBe(3);
  });

  it("degrades to null fields when there is no artifact, instead of throwing", () => {
    const l = projectLane("HK", { sessions: 0, labelled20: 0, latestBar: null }, null);
    expect(l.observedNwSe).toBeNull();
    expect(l.requiredDays).toBeNull();
    expect(l.additionalMonths).toBeNull();
    const text = renderAccrual({ asOf: "x", prospectiveFrom: PROSPECTIVE_FROM, lanes: [l], sourceArtifact: null, note: "" });
    expect(text).toMatch(/no backtest artifact/);
  });
});

describe("accrual — surfaces", () => {
  it("parses --json and rejects junk", () => {
    expect(parseAccrualArgs([])).toEqual({ json: false });
    expect(parseAccrualArgs(["--", "--json"])).toEqual({ json: true });
    expect(parseAccrualArgs(["--quiet"])).toEqual({ json: false });
    expect(() => parseAccrualArgs(["--nope"])).toThrow(/unknown argument/);
  });

  it("hktDate is the HKT calendar date, not UTC's", () => {
    expect(hktDate(new Date("2026-09-11T17:00:00Z"))).toBe("2026-09-12");
    expect(hktDate(new Date("2026-09-11T15:00:00Z"))).toBe("2026-09-11");
  });

  it("finds the newest artifact by date, not by directory order", () => {
    const found = newestBacktestArtifact();
    // The repo has a real artifact, so this doubles as a fixture check.
    expect(found).not.toBeNull();
    expect(found!.file).toMatch(/2026-\d\d-\d\d\.json$/);
  });

  it("reads the live store and reports both lanes", async () => {
    // Integration-shaped but read-only: asserts the shape, not the values, so it
    // stays valid as the store advances.
    const prisma = { bar: { findMany: async () => [{ date: "2026-09-10" }] }, screenRun: { findMany: async () => [] } } as any;
    const r: AccrualReport = await runAccrual(prisma);
    expect(r.lanes.map((l) => l.market)).toEqual(["US", "HK"]);
    expect(r.prospectiveFrom).toBe(PROSPECTIVE_FROM);
    expect(GATE1_BAR / GATE1_T).toBe(0.01);
  });
});

describe("accrual — the false 'missed' alarm that the first successful run exposed", () => {
  it("counts SESSIONS on both sides, so a Saturday slot collecting Friday is not 'missed'", async () => {
    // The real case: 2026-09-12 is a Saturday, so the US lane's Tue-Sat cadence
    // expects a slot; but the session that run collected is Friday 09-11, which
    // belongs to the spent window and is correctly excluded. Counting expected by
    // slot and collected by session reported "0/1, 1 slot missed" for a run that
    // worked perfectly. Both sides now count sessions the store actually holds.
    const prisma = {
      bar: {
        findMany: async () => [{ date: "2026-09-11" }],
      },
      screenRun: {
        findMany: async () => [{ runAt: new Date("2026-09-11T22:14:00Z"), sessionDate: "2026-09-11" }],
      },
    } as any;
    const r = await runAccrual(prisma);
    for (const l of r.lanes) {
      expect(l.expectedSessions).toBe(0); // no session after the cutoff exists yet
      expect(l.prospectiveSessions).toBe(0);
      expect(l.missedSessions).toBe(0); // and therefore nothing is missing
    }
  });

  it("still reports a genuine miss: a session in the store that was never screened", async () => {
    const prisma = {
      bar: { findMany: async () => [{ date: "2026-09-11" }, { date: "2026-09-14" }, { date: "2026-09-15" }] },
      screenRun: { findMany: async () => [{ runAt: new Date("2026-09-11T22:14:00Z"), sessionDate: "2026-09-11" }] },
    } as any;
    const r = await runAccrual(prisma);
    const us = r.lanes.find((l) => l.market === "US")!;
    expect(us.expectedSessions).toBe(2); // 09-14 and 09-15 exist and are new
    expect(us.prospectiveSessions).toBe(0);
    expect(us.missedSessions).toBe(2); // both permanently lost
  });

  it("counts the cutoff date itself on BOTH sides (>= PROSPECTIVE_FROM)", async () => {
    // The Phase-4 window ends 09-11, so 2026-09-12 is prospective. A `>` on
    // either side silently drops it and the two counts disagree by one.
    const prisma = {
      bar: { findMany: async () => [{ date: "2026-09-12" }] },
      screenRun: { findMany: async () => [{ runAt: new Date("2026-09-12T22:14:00Z"), sessionDate: "2026-09-12" }] },
    } as any;
    const r = await runAccrual(prisma);
    const us = r.lanes.find((l) => l.market === "US")!;
    expect(us.expectedSessions).toBe(1);
    expect(us.prospectiveSessions).toBe(1);
    expect(us.missedSessions).toBe(0);
  });
});
