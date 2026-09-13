/**
 * Ops health (W4a, docs/ops-hardening-plan.md).
 *
 * The cadence arithmetic is the part most likely to be quietly wrong, so these
 * tests pin concrete HKT instants. Cadence re-declared 2026-09-13: the expected
 * event per lane is the GUARDED evening catch-up (20:30/23:03 HKT); the
 * 06:10/16:50 jobs are opportunistic bonuses that can satisfy the expectation
 * early but can never be "missed". A lane is missed only when it was still
 * behind (store newer than screened, or newest screen lacking a complete chain
 * deep-dive) after an evening's slots on a day the store held a completed
 * unscreened session. HK sessions are due the same evening (lag 0), US sessions
 * the following HKT evening (lag 1 by construction).
 *
 * No DB, no network: computeHealth is called with a stub prisma.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeHealth, MISSED_RUN_GRACE_HOURS, type HealthReport } from "../../src/ops/health.js";
import { parseOpsHealthArgs, renderHealth, todayHkt, opsHealthArtifactPath, LOG_DIR } from "../../src/cli/ops-health.js";

/** HKT instant as a Date (HKT = UTC+8, no DST since 1979). */
function hkt(s: string): Date {
  return new Date(`${s}+08:00`);
}

interface RunRow {
  id: number;
  market: string;
  runAt: Date;
  /** DeepDiveRun provenance; undefined simulates a pre-column chain row. */
  source?: "chain" | "adhoc";
  /** Set when this deep-dive is attached to a screen run (the verdict leg). */
  screenRunId?: number;
}
interface ScreenRow {
  id: number;
  market: string;
  runAt: Date;
  /** Newest session this run screened; undefined simulates a pre-column row. */
  sessionDate?: string;
  /** ScreenRun provenance — "rescreen" rows carry a fresh runAt + old session. */
  source?: "chain" | "rescreen";
}

function stubPrisma(opts: { runs?: RunRow[]; screens?: ScreenRow[]; bars?: Record<string, string | string[]>; running?: RunRow[] } = {}) {
  const runs = opts.runs ?? [];
  const screens = opts.screens ?? [];
  const bars = opts.bars ?? {};
  const running = opts.running ?? [];
  const barDates = (m: string): string[] => {
    const v = bars[m];
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
  };
  return {
    deepDiveRun: {
      findFirst: async ({ where }: any) => {
        const pool = where.status === "running" ? running : runs;
        const match = pool
          .filter((r) => (where.market ? r.market === where.market : true))
          .filter((r) => (where.source ? r.source === where.source : true))
          .filter((r) => (where.screenRunId !== undefined ? r.screenRunId === where.screenRunId : true))
          .filter((r) => (where.runAt?.lt ? r.runAt.getTime() < where.runAt.lt.getTime() : true))
          .sort((a, b) => b.runAt.getTime() - a.runAt.getTime());
        return match[0] ?? null;
      },
    },
    screenRun: {
      findFirst: async ({ where, orderBy }: any) => {
        const pool = screens
          .filter((r) => r.market === where.market)
          .filter((r) => (where.sessionDate?.not === "" ? Boolean(r.sessionDate) : true));
        // Honour the orderBy the way SQLite would — the whole point of the
        // 2026-09-13 fix is WHICH row this returns when a rescreen row has the
        // newest runAt but an old sessionDate.
        const bySession = Array.isArray(orderBy) ? orderBy.some((o: any) => o.sessionDate) : Boolean(orderBy?.sessionDate);
        return (
          [...pool].sort((a, b) =>
            bySession
              ? (b.sessionDate ?? "").localeCompare(a.sessionDate ?? "") || b.runAt.getTime() - a.runAt.getTime()
              : b.runAt.getTime() - a.runAt.getTime(),
          )[0] ?? null
        );
      },
      findMany: async ({ where }: any) =>
        screens
          .filter((r) => r.market === where.market)
          .filter((r) => (where.sessionDate?.not === "" ? Boolean(r.sessionDate) : true))
          .map((r) => ({ sessionDate: r.sessionDate })),
    },
    bar: {
      findFirst: async ({ where }: any) => {
        const ds = barDates(where.instrument.market);
        return ds.length ? { date: ds[ds.length - 1] } : null;
      },
      findMany: async ({ where }: any) => barDates(where.instrument.market).map((date) => ({ date })),
    },
  } as any;
}

let reportsDir: string;

beforeAll(() => {
  reportsDir = mkdtempSync(path.join(tmpdir(), "ops-health-"));
});
afterAll(() => rmSync(reportsDir, { recursive: true, force: true }));

const lane = (r: HealthReport, m: "HK" | "US") => r.lanes.find((l) => l.market === m)!;

describe("computeHealth — lane cadence (guarded evening catch-up)", () => {
  it("machine-on day: the 06:10 opportunistic run fired, evening is a no-op → HEALTHY", async () => {
    // US lane: Saturday 06:10 screened Friday's session (store holds exactly
    // that session) with a complete chain deep-dive. The weekend evenings are
    // not due at all — nothing can be missed.
    const r = await computeHealth(
      stubPrisma({
        runs: [{ id: 9, market: "US", runAt: hkt("2026-09-12T06:15:00"), source: "chain", screenRunId: 20 }],
        screens: [{ id: 20, market: "US", runAt: hkt("2026-09-12T06:12:00"), sessionDate: "2026-09-11" }],
        bars: { US: "2026-09-11" },
      }),
      { now: hkt("2026-09-13T20:00:00"), reportsDir },
    );
    const us = lane(r, "US");
    expect(us.level).toBe("healthy");
    expect(us.expectedRunsMissed).toBe(0);
  });

  it("normal day: nothing ran before the 20:30 catch-up → still HEALTHY (the evening is not late yet)", async () => {
    // HK lane, Monday 19:00: the store holds today's completed session (bars
    // are storable from 16:10), no run has screened it, but the evening slots
    // (20:30/23:03) have not passed — the catch-up is expected TONIGHT.
    const r = await computeHealth(
      stubPrisma({
        runs: [{ id: 6, market: "HK", runAt: hkt("2026-09-11T20:50:00"), source: "chain", screenRunId: 14 }],
        screens: [{ id: 14, market: "HK", runAt: hkt("2026-09-11T20:40:00"), sessionDate: "2026-09-11" }],
        bars: { HK: "2026-09-14" },
      }),
      { now: hkt("2026-09-14T19:00:00"), reportsDir },
    );
    const hk = lane(r, "HK");
    expect(hk.expectedRunsMissed).toBe(0);
    expect(hk.level).toBe("healthy");
  });

  it("normal day after the catch-up ran at 20:30 → HEALTHY", async () => {
    const r = await computeHealth(
      stubPrisma({
        runs: [{ id: 7, market: "HK", runAt: hkt("2026-09-14T20:50:00"), source: "chain", screenRunId: 15 }],
        screens: [{ id: 15, market: "HK", runAt: hkt("2026-09-14T20:40:00"), sessionDate: "2026-09-14" }],
        bars: { HK: "2026-09-14" },
      }),
      { now: hkt("2026-09-14T21:30:00"), reportsDir },
    );
    expect(lane(r, "HK").level).toBe("healthy");
    expect(lane(r, "HK").expectedRunsMissed).toBe(0);
  });

  it("genuinely missed day: the evening slots passed and the lane is still behind → counted (1 = WARN)", async () => {
    // HK store holds Friday's session, last screened Thursday, and Friday's
    // 20:30/23:03 slots never ran (machine off). Saturday 08:00 is past
    // 23:03+6h grace, so Friday evening is a missed catch-up.
    const r = await computeHealth(
      stubPrisma({
        runs: [{ id: 5, market: "HK", runAt: hkt("2026-09-10T20:50:00"), source: "chain", screenRunId: 13 }],
        screens: [{ id: 13, market: "HK", runAt: hkt("2026-09-10T20:40:00"), sessionDate: "2026-09-10" }],
        bars: { HK: "2026-09-11" },
      }),
      { now: hkt("2026-09-12T08:00:00"), reportsDir },
    );
    const hk = lane(r, "HK");
    expect(hk.expectedRunsMissed).toBe(1);
    expect(hk.level).toBe("warn");
    expect(hk.reasons.join(" ")).toMatch(/catch-up/);
  });

  it("a second missed evening escalates to ALERT (weekend evenings do not count)", async () => {
    // Same state, now Tuesday 05:30: Friday's and Monday's evenings both
    // passed with the lane behind; Sat/Sun are not HK evenings.
    const r = await computeHealth(
      stubPrisma({
        runs: [{ id: 5, market: "HK", runAt: hkt("2026-09-10T20:50:00"), source: "chain", screenRunId: 13 }],
        screens: [{ id: 13, market: "HK", runAt: hkt("2026-09-10T20:40:00"), sessionDate: "2026-09-10" }],
        bars: { HK: "2026-09-11" },
      }),
      { now: hkt("2026-09-15T05:30:00"), reportsDir },
    );
    expect(lane(r, "HK").expectedRunsMissed).toBe(2);
    expect(lane(r, "HK").level).toBe("alert");
  });

  it("US lag 1 by construction: Monday's session is due TUESDAY evening, never Monday", async () => {
    // US store holds Monday's session (arrived Tue ~04:00 HKT), Friday was
    // screened Saturday. Tuesday 19:00 — the evening the session is due —
    // has not passed its slots, so nothing is missed.
    const state = stubPrisma({
      runs: [{ id: 9, market: "US", runAt: hkt("2026-09-12T06:15:00"), source: "chain", screenRunId: 20 }],
      screens: [{ id: 20, market: "US", runAt: hkt("2026-09-12T06:12:00"), sessionDate: "2026-09-11" }],
      bars: { US: "2026-09-14" },
    });
    const r = await computeHealth(state, { now: hkt("2026-09-15T19:00:00"), reportsDir });
    expect(lane(r, "US").expectedRunsMissed).toBe(0);
    expect(lane(r, "US").level).toBe("healthy");

    // Wednesday 06:00: Tuesday's 23:03 slot + 6h grace has passed and the lane
    // is still behind → one missed evening, warn.
    const late = await computeHealth(state, { now: hkt("2026-09-16T06:00:00"), reportsDir });
    expect(lane(late, "US").expectedRunsMissed).toBe(1);
    expect(lane(late, "US").level).toBe("warn");
  });

  it("verdict leg: a screened session without a complete CHAIN deep-dive is behind (adhoc does not count)", async () => {
    // HK screened Friday at 20:40, but only an ad-hoc deep-dive exists — the
    // chain verdict never completed. Saturday 08:00: Friday evening is missed.
    const r = await computeHealth(
      stubPrisma({
        runs: [{ id: 31, market: "HK", runAt: hkt("2026-09-11T20:50:00"), source: "adhoc", screenRunId: 30 }],
        screens: [{ id: 30, market: "HK", runAt: hkt("2026-09-11T20:40:00"), sessionDate: "2026-09-11" }],
        bars: { HK: "2026-09-11" },
      }),
      { now: hkt("2026-09-12T08:00:00"), reportsDir },
    );
    const hk = lane(r, "HK");
    expect(hk.expectedRunsMissed).toBe(1);
    expect(hk.level).toBe("warn");
  });

  it("a lane with no complete run is ALERT and reports it plainly", async () => {
    const r = await computeHealth(stubPrisma(), { now: hkt("2026-09-10T22:00:00"), reportsDir });
    const us = lane(r, "US");
    expect(us.level).toBe("alert");
    expect(us.lastCompleteRunId).toBeNull();
    expect(us.reasons.join(" ")).toMatch(/no complete deep-dive run/);
  });
});

describe("computeHealth — run provenance", () => {  // Measured 2026-09-12: HK's "last complete run" was an ad-hoc 3-name smoke
  // run. The newest complete **chain** run is the lane's truth (same policy as
  // ReportsService.daily) — though with the 2026-09-13 cadence the missed count
  // comes from the store/screen state, not the run clock.
  it("a newer adhoc run does not replace the older chain run as lastComplete", async () => {
    const r = await computeHealth(
      stubPrisma({
        runs: [
          { id: 6, market: "HK", runAt: hkt("2026-09-11T20:50:00"), source: "chain", screenRunId: 14 },
          { id: 8, market: "HK", runAt: hkt("2026-09-12T15:00:00"), source: "adhoc" },
        ],
        screens: [{ id: 14, market: "HK", runAt: hkt("2026-09-11T20:40:00"), sessionDate: "2026-09-11" }],
        bars: { HK: "2026-09-11" },
      }),
      { now: hkt("2026-09-13T20:00:00"), reportsDir },
    );
    const hk = lane(r, "HK");
    expect(hk.lastCompleteRunId).toBe(6);
    // Screen current through the store's newest session, verdict attached →
    // not behind, nothing missed. (Weekend: no HK evenings due anyway.)
    expect(hk.expectedRunsMissed).toBe(0);
    expect(hk.level).toBe("healthy");
  });

  it("falls back to any provenance only when the lane has no chain run at all", async () => {
    const r = await computeHealth(
      stubPrisma({
        runs: [{ id: 8, market: "HK", runAt: hkt("2026-09-11T20:50:00"), source: "adhoc", screenRunId: 14 }],
        screens: [{ id: 14, market: "HK", runAt: hkt("2026-09-11T20:40:00"), sessionDate: "2026-09-11" }],
        bars: { HK: "2026-09-11" },
      }),
      { now: hkt("2026-09-11T21:30:00"), reportsDir },
    );
    const hk = lane(r, "HK");
    expect(hk.lastCompleteRunId).toBe(8);
    // The verdict leg is unsatisfied (adhoc ≠ chain), but Friday's evening
    // slots have not passed yet — not late.
    expect(hk.expectedRunsMissed).toBe(0);
    expect(hk.level).toBe("healthy");
  });
});

describe("computeHealth — rescreen rows and rescreenable holes (2026-09-13)", () => {
  it("a rescreen row (new runAt, OLD sessionDate) is not the newest SESSION — the lane stays healthy", async () => {
    // The ordering fix: both the screen leg and the verdict leg must read the
    // run with the MAX sessionDate (id 14), not the newest runAt (id 15).
    // Without it this state reads "behind": lastScreened 09-09 < store 09-11,
    // and the verdict-leg check looks for a chain deep-dive on the rescreen row.
    const r = await computeHealth(
      stubPrisma({
        runs: [{ id: 6, market: "HK", runAt: hkt("2026-09-11T20:50:00"), source: "chain", screenRunId: 14 }],
        screens: [
          { id: 14, market: "HK", runAt: hkt("2026-09-11T20:40:00"), sessionDate: "2026-09-11", source: "chain" },
          { id: 15, market: "HK", runAt: hkt("2026-09-13T10:00:00"), sessionDate: "2026-09-09", source: "rescreen" },
        ],
        bars: { HK: "2026-09-11" },
      }),
      { now: hkt("2026-09-13T20:00:00"), reportsDir },
    );
    const hk = lane(r, "HK");
    expect(hk.lastScreenRunId).toBe(14);
    expect(hk.level).toBe("healthy");
    expect(hk.expectedRunsMissed).toBe(0);
  });

  it("reports rescreenable holes informationally — the level does not move", async () => {
    // Screened through 09-15 (with a chain verdict); the store also holds
    // 09-14, which was never screened — a rescreenable hole, not an emergency.
    const r = await computeHealth(
      stubPrisma({
        runs: [{ id: 6, market: "HK", runAt: hkt("2026-09-15T20:50:00"), source: "chain", screenRunId: 14 }],
        screens: [{ id: 14, market: "HK", runAt: hkt("2026-09-15T20:40:00"), sessionDate: "2026-09-15", source: "chain" }],
        bars: { HK: ["2026-09-11", "2026-09-14", "2026-09-15"] },
      }),
      { now: hkt("2026-09-16T10:00:00"), reportsDir },
    );
    const hk = lane(r, "HK");
    expect(hk.rescreenableHoles).toBe(1); // 09-14; 09-11 predates PROSPECTIVE_FROM
    expect(hk.level).toBe("healthy");
    expect(hk.reasons.join(" ")).not.toMatch(/hole/);
    const text = renderHealth(r);
    expect(text).toMatch(/1 rescreenable hole/);
    expect(text).toContain("pnpm -C apps/api screen:rescreen -- --market hk --holes");
  });

  it("the session tonight's catch-up will screen is pending, not a hole", async () => {
    const r = await computeHealth(
      stubPrisma({
        runs: [{ id: 6, market: "HK", runAt: hkt("2026-09-15T20:50:00"), source: "chain", screenRunId: 14 }],
        screens: [{ id: 14, market: "HK", runAt: hkt("2026-09-15T20:40:00"), sessionDate: "2026-09-15", source: "chain" }],
        bars: { HK: ["2026-09-14", "2026-09-15", "2026-09-16"] },
      }),
      { now: hkt("2026-09-16T19:00:00"), reportsDir },
    );
    const hk = lane(r, "HK");
    expect(hk.rescreenableHoles).toBe(1); // 09-14 only; 09-16 is tonight's catch-up's job
    // 19:00 is before the evening slots — behind but not yet missed.
    expect(hk.level).toBe("healthy");
  });

  it("a still-unclosed session is not a hole (sessionClosed)", async () => {
    // 10:00 HKT — the 09-16 HK session is still forming.
    const r = await computeHealth(
      stubPrisma({
        runs: [{ id: 6, market: "HK", runAt: hkt("2026-09-15T20:50:00"), source: "chain", screenRunId: 14 }],
        screens: [{ id: 14, market: "HK", runAt: hkt("2026-09-15T20:40:00"), sessionDate: "2026-09-15", source: "chain" }],
        bars: { HK: ["2026-09-15", "2026-09-16"] },
      }),
      { now: hkt("2026-09-16T10:00:00"), reportsDir },
    );
    expect(lane(r, "HK").rescreenableHoles).toBe(0);
  });
});

describe("computeHealth — crashed runs and surfaces", () => {
  it("a 'running' row older than 2h is ALERT (the 09-10 zombie state)", async () => {
    const r = await computeHealth(
      stubPrisma({
        runs: [{ id: 3, market: "US", runAt: hkt("2026-09-10T08:37:00") }],
        running: [{ id: 16, market: "US", runAt: hkt("2026-09-10T08:35:00") }],
      }),
      { now: hkt("2026-09-10T22:00:00"), reportsDir },
    );
    const us = lane(r, "US");
    expect(us.staleRunning).toEqual({ id: 16, runAt: hkt("2026-09-10T08:35:00").toISOString() });
    expect(us.level).toBe("alert");
    expect(us.reasons.join(" ")).toMatch(/crashed or killed/);
  });

  it("a 'running' row inside 2h is not stale (a healthy pool takes ~3 min)", async () => {
    const r = await computeHealth(
      stubPrisma({
        runs: [{ id: 3, market: "US", runAt: hkt("2026-09-10T21:00:00") }],
        running: [{ id: 17, market: "US", runAt: hkt("2026-09-10T21:50:00") }],
      }),
      { now: hkt("2026-09-10T22:00:00"), reportsDir },
    );
    expect(lane(r, "US").staleRunning).toBeNull();
  });

  it("carries dataThrough and the screen run id per lane (W3b surfacing)", async () => {
    const r = await computeHealth(
      stubPrisma({
        runs: [{ id: 6, market: "HK", runAt: hkt("2026-09-10T20:50:00"), source: "chain", screenRunId: 14 }],
        screens: [{ id: 14, market: "HK", runAt: hkt("2026-09-10T20:40:00"), sessionDate: "2026-09-09" }],
        bars: { HK: "2026-09-09", US: "2026-09-08" },
      }),
      { now: hkt("2026-09-10T22:00:00"), reportsDir },
    );
    expect(lane(r, "HK").dataThrough).toBe("2026-09-09");
    expect(lane(r, "US").dataThrough).toBe("2026-09-08");
    expect(lane(r, "HK").lastScreenRunId).toBe(14);
    expect(lane(r, "HK").lastCompleteRunId).toBe(6);
  });
});

describe("computeHealth — weekly jobs", () => {
  it("an 8-day-old artifact is healthy; 9 days is overdue", async () => {
    writeFileSync(path.join(reportsDir, "sentinel-2026-09-06.json"), "{}");
    writeFileSync(path.join(reportsDir, "f10-refresh-2026-09-06.json"), "{}");

    const fresh = await computeHealth(stubPrisma(), { now: hkt("2026-09-14T09:00:00"), reportsDir });
    expect(fresh.jobs.find((j) => j.job === "sentinel")!.level).toBe("healthy");

    const stale = await computeHealth(stubPrisma(), { now: hkt("2026-09-15T09:00:00"), reportsDir });
    expect(stale.jobs.find((j) => j.job === "sentinel")!.level).toBe("alert");
    expect(stale.jobs.find((j) => j.job === "sentinel")!.reasons.join(" ")).toMatch(/overdue/);
  });

  it("a missing artifact is ALERT but says 'cannot confirm', not 'never ran'", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "ops-health-empty-"));
    const la = mkdtempSync(path.join(tmpdir(), "ops-health-la-"));
    try {
      plistInstalledAt(la, "com.agentic-trading.weekly-f10", hkt("2026-09-06T09:17:00"));
      const r = await computeHealth(stubPrisma(), {
        now: hkt("2026-09-14T09:00:00"),
        reportsDir: empty,
        launchAgentsDir: la,
      });
      const f10 = r.jobs.find((j) => j.job === "f10")!;
      expect(f10.level).toBe("alert");
      expect(f10.lastArtifactDate).toBeNull();
      expect(f10.reasons.join(" ")).toMatch(/cannot confirm/);
      expect(f10.reasons.join(" ")).not.toMatch(/never run/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(la, { recursive: true, force: true });
    }
  });

  it("a missing reports dir is handled, not thrown", async () => {
    const la = mkdtempSync(path.join(tmpdir(), "ops-health-la-"));
    const logs = mkdtempSync(path.join(tmpdir(), "ops-health-logs-"));
    try {
      for (const label of ["com.agentic-trading.weekly-sentinel", "com.agentic-trading.weekly-f10"]) {
        plistInstalledAt(la, label, hkt("2026-09-06T09:17:00"));
      }
      const r = await computeHealth(stubPrisma(), {
        now: hkt("2026-09-14T09:00:00"),
        reportsDir: "/nonexistent/ops-health-test",
        logsDir: logs,
        launchAgentsDir: la,
      });
      expect(r.jobs.every((j) => j.level === "alert")).toBe(true);
    } finally {
      rmSync(la, { recursive: true, force: true });
      rmSync(logs, { recursive: true, force: true });
    }
  });
});

describe("computeHealth — a weekly job must be due before it can be late", () => {
  // Regression for the 2026-09-11 false alarm: the f10 job was installed
  // Sun 09-10 23:21, *after* that morning's 09:17 slot, so its first due slot
  // was Sun 09-13. Health still reported ALERT, and because any job alert pins
  // the whole report, the dashboard banner went red permanently for a job that
  // had never been due — and could never go green before 09-13.
  const installed = hkt("2026-09-10T23:21:00");
  const label = "com.agentic-trading.weekly-f10";

  it("is HEALTHY (not yet due) before the first Sunday slot", async () => {
    const la = mkdtempSync(path.join(tmpdir(), "ops-health-la-"));
    const rep = mkdtempSync(path.join(tmpdir(), "ops-health-rep-"));
    try {
      plistInstalledAt(la, label, installed);
      const r = await computeHealth(stubPrisma(), {
        now: hkt("2026-09-11T20:08:00"),
        reportsDir: rep,
        launchAgentsDir: la,
      });
      const f10 = r.jobs.find((j) => j.job === "f10")!;
      expect(f10.level).toBe("healthy");
      expect(f10.lastArtifactDate).toBeNull();
      expect(f10.reasons.join(" ")).toMatch(/not yet due/);
    } finally {
      rmSync(la, { recursive: true, force: true });
      rmSync(rep, { recursive: true, force: true });
    }
  });

  it("is ALERT once a Sunday slot has passed", async () => {
    const la = mkdtempSync(path.join(tmpdir(), "ops-health-la-"));
    const rep = mkdtempSync(path.join(tmpdir(), "ops-health-rep-"));
    try {
      plistInstalledAt(la, label, installed);
      // Sun 09-13 09:17 has passed (1 slot); the 6h grace is long gone.
      const r = await computeHealth(stubPrisma(), {
        now: hkt("2026-09-14T09:00:00"),
        reportsDir: rep,
        launchAgentsDir: la,
      });
      const f10 = r.jobs.find((j) => j.job === "f10")!;
      expect(f10.level).toBe("alert");
      expect(f10.reasons.join(" ")).toMatch(/cannot confirm/);
      expect(f10.reasons.join(" ")).toMatch(/1 scheduled slot/);
    } finally {
      rmSync(la, { recursive: true, force: true });
      rmSync(rep, { recursive: true, force: true });
    }
  });

  it("is ALERT, undated, when the plist is missing (cannot prove the install)", async () => {
    const la = mkdtempSync(path.join(tmpdir(), "ops-health-la-"));
    const rep = mkdtempSync(path.join(tmpdir(), "ops-health-rep-"));
    try {
      const r = await computeHealth(stubPrisma(), {
        now: hkt("2026-09-14T09:00:00"),
        reportsDir: rep,
        launchAgentsDir: la,
      });
      const f10 = r.jobs.find((j) => j.job === "f10")!;
      expect(f10.level).toBe("alert");
      expect(f10.reasons.join(" ")).toMatch(/to date the install/);
    } finally {
      rmSync(la, { recursive: true, force: true });
      rmSync(rep, { recursive: true, force: true });
    }
  });

  it("an artifact that exists is judged by age, never by the plist mtime", async () => {
    const la = mkdtempSync(path.join(tmpdir(), "ops-health-la-"));
    const rep = mkdtempSync(path.join(tmpdir(), "ops-health-rep-"));
    try {
      // Plist says "just installed"; the artifact says "ran 4 days ago".
      plistInstalledAt(la, label, hkt("2026-09-14T08:00:00"));
      writeFileSync(path.join(rep, "f10-refresh-2026-09-10.json"), "{}");
      const r = await computeHealth(stubPrisma(), {
        now: hkt("2026-09-14T09:00:00"),
        reportsDir: rep,
        launchAgentsDir: la,
      });
      expect(r.jobs.find((j) => j.job === "f10")!.level).toBe("healthy");
    } finally {
      rmSync(la, { recursive: true, force: true });
      rmSync(rep, { recursive: true, force: true });
    }
  });
});

describe("computeHealth — the weekly validation digest job", () => {
  // Same due-ness rules as f10 (install-anchored), but the artifact is
  // logs/validation-digest-<date>.json at the repo root, not apps/api/reports.
  const label = "com.agentic-trading.weekly-validation";

  it("is HEALTHY (not yet due) before its first Sunday slot", async () => {
    const la = mkdtempSync(path.join(tmpdir(), "ops-health-la-"));
    const logs = mkdtempSync(path.join(tmpdir(), "ops-health-logs-"));
    try {
      // Installed Sun 09-13 10:00 — after that morning's 09:47 slot, so the
      // first due slot is Sun 09-20 09:47.
      plistInstalledAt(la, label, hkt("2026-09-13T10:00:00"));
      const r = await computeHealth(stubPrisma(), {
        now: hkt("2026-09-13T20:00:00"),
        reportsDir,
        logsDir: logs,
        launchAgentsDir: la,
      });
      const v = r.jobs.find((j) => j.job === "validation")!;
      expect(v.level).toBe("healthy");
      expect(v.lastArtifactDate).toBeNull();
      expect(v.reasons.join(" ")).toMatch(/not yet due/);
    } finally {
      rmSync(la, { recursive: true, force: true });
      rmSync(logs, { recursive: true, force: true });
    }
  });

  it("is ALERT once a Sunday slot has passed with no digest", async () => {
    const la = mkdtempSync(path.join(tmpdir(), "ops-health-la-"));
    const logs = mkdtempSync(path.join(tmpdir(), "ops-health-logs-"));
    try {
      plistInstalledAt(la, label, hkt("2026-09-10T23:21:00"));
      // Sun 09-13 09:47 has passed (1 slot); the 6h grace is long gone.
      const r = await computeHealth(stubPrisma(), {
        now: hkt("2026-09-14T09:00:00"),
        reportsDir,
        logsDir: logs,
        launchAgentsDir: la,
      });
      const v = r.jobs.find((j) => j.job === "validation")!;
      expect(v.level).toBe("alert");
      expect(v.reasons.join(" ")).toMatch(/cannot confirm/);
      expect(v.reasons.join(" ")).toMatch(/1 scheduled slot/);
    } finally {
      rmSync(la, { recursive: true, force: true });
      rmSync(logs, { recursive: true, force: true });
    }
  });

  it("a digest artifact in logs/ is judged by age, like the other weekly jobs", async () => {
    const logs = mkdtempSync(path.join(tmpdir(), "ops-health-logs-"));
    try {
      writeFileSync(path.join(logs, "validation-digest-2026-09-13.json"), digestJson(null, 0.02));
      const r = await computeHealth(stubPrisma(), {
        now: hkt("2026-09-14T09:00:00"),
        reportsDir,
        logsDir: logs,
      });
      const v = r.jobs.find((j) => j.job === "validation")!;
      expect(v.level).toBe("healthy");
      expect(v.lastArtifactDate).toBe("2026-09-13");
    } finally {
      rmSync(logs, { recursive: true, force: true });
    }
  });
});

describe("computeHealth — the projection watch (Phase-5 A3)", () => {
  it("sd ratio >= 1.5 is a WARN with the A3 re-pricing reason — never an alert", async () => {
    const logs = mkdtempSync(path.join(tmpdir(), "ops-health-logs-"));
    try {
      writeFileSync(path.join(logs, "validation-digest-2026-09-13.json"), digestJson(0.032, 0.02));
      const r = await computeHealth(stubPrisma(), {
        now: hkt("2026-09-14T09:00:00"),
        reportsDir,
        logsDir: logs,
      });
      const v = r.jobs.find((j) => j.job === "validation")!;
      expect(v.level).toBe("warn");
      expect(v.reasons.join(" ")).toContain(
        "projection watch: measured per-day IC sd is 1.6x the assumed value — " +
          "Phase-5 A3's re-pricing decision is due while still unlabelled",
      );
    } finally {
      rmSync(logs, { recursive: true, force: true });
    }
  });

  it("null sd fields are silent — the sd is unmeasurable for months", async () => {
    const logs = mkdtempSync(path.join(tmpdir(), "ops-health-logs-"));
    try {
      writeFileSync(path.join(logs, "validation-digest-2026-09-13.json"), digestJson(null, 0.02));
      const r = await computeHealth(stubPrisma(), {
        now: hkt("2026-09-14T09:00:00"),
        reportsDir,
        logsDir: logs,
      });
      const v = r.jobs.find((j) => j.job === "validation")!;
      expect(v.level).toBe("healthy");
      expect(v.reasons.join(" ")).not.toMatch(/projection watch/);
    } finally {
      rmSync(logs, { recursive: true, force: true });
    }
  });

  it("a ratio below 1.5 is silent", async () => {
    const logs = mkdtempSync(path.join(tmpdir(), "ops-health-logs-"));
    try {
      writeFileSync(path.join(logs, "validation-digest-2026-09-13.json"), digestJson(0.024, 0.02));
      const r = await computeHealth(stubPrisma(), {
        now: hkt("2026-09-14T09:00:00"),
        reportsDir,
        logsDir: logs,
      });
      const v = r.jobs.find((j) => j.job === "validation")!;
      expect(v.level).toBe("healthy");
      expect(v.reasons.join(" ")).not.toMatch(/projection watch/);
    } finally {
      rmSync(logs, { recursive: true, force: true });
    }
  });
});

/** The shape scripts/weekly-validation.sh writes to
 *  logs/validation-digest-<date>.json — pinned so the script and the health
 *  check cannot drift apart silently. */
function digestJson(sdDay: number | null, sdTheory: number | null): string {
  return JSON.stringify({
    date: "2026-09-13",
    verdictValidateExit: 0,
    phase4cAccrualExit: 0,
    pooled: { labelled: 12, days: 3, daysNeeded: 812, sdDay, sdTheory },
    lanes: {
      HK: { labelled: 6, days: 2, daysNeeded: 812, sdDay, sdTheory },
      US: { labelled: 6, days: 2, daysNeeded: 812, sdDay, sdTheory },
    },
  });
}

/** A plist whose *mtime* dates the install — install.sh copies, so mtime is
 *  the install instant and the anchor for "has it been due yet?". */
function plistInstalledAt(dir: string, label: string, at: Date): void {
  const p = path.join(dir, `${label}.plist`);
  writeFileSync(p, "<plist/>");
  utimesSync(p, at, at);
}

describe("ops-health CLI surface", () => {
  it("parses --lane and rejects junk", () => {
    expect(parseOpsHealthArgs([])).toEqual({});
    expect(parseOpsHealthArgs(["--", "--lane", "us"])).toEqual({ lane: "us" });
    expect(parseOpsHealthArgs(["--lane", "hk"])).toEqual({ lane: "hk" });
    expect(() => parseOpsHealthArgs(["--lane", "cn"])).toThrow(/--lane must be hk\|us/);
    expect(() => parseOpsHealthArgs(["--nope"])).toThrow(/unknown argument/);
  });

  it("renders every lane and job with its level", async () => {
    const r = await computeHealth(stubPrisma(), { now: hkt("2026-09-10T22:00:00"), reportsDir });
    const text = renderHealth(r);
    expect(text).toMatch(/OPS HEALTH/);
    expect(text).toMatch(/^HK: /m);
    expect(text).toMatch(/^US: /m);
    expect(text).toMatch(/^sentinel: /m);
    expect(text).toMatch(/^f10: /m);
    expect(text).toMatch(/^validation: /m);
  });

  it("todayHkt is the HKT calendar date, not UTC's", () => {
    // 2026-09-10T17:00Z is already 2026-09-11 in HKT (+08:00).
    expect(todayHkt(new Date("2026-09-10T17:00:00Z"))).toBe("2026-09-11");
    expect(todayHkt(new Date("2026-09-10T15:00:00Z"))).toBe("2026-09-10");
  });

  it("writes the artifact to the REPO-ROOT logs/, not apps/logs", () => {
    // Regression: a one-level-off join put it in apps/logs, where the launchd
    // convention and the log readers do not look.
    expect(LOG_DIR.endsWith(`${path.sep}logs`)).toBe(true);
    expect(LOG_DIR).not.toMatch(/apps\/logs$/);
    expect(opsHealthArtifactPath(new Date("2026-09-10T15:00:00Z"))).toBe(
      path.join(LOG_DIR, "ops-health-2026-09-10.json"),
    );
  });

  it("grace is 6h and runs are alert-free inside it", () => {
    expect(MISSED_RUN_GRACE_HOURS).toBe(6);
  });
});
