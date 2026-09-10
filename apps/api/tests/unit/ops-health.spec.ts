/**
 * Ops health (W4a, docs/ops-hardening-plan.md).
 *
 * The cadence arithmetic is the part most likely to be quietly wrong, so these
 * tests pin concrete HKT instants — especially the Sat→Tue weekend gap that the
 * earlier "age in hours" idea could not distinguish from a failure, and the
 * catch-up-on-wake case that must stay a warn rather than an alert.
 *
 * No DB, no network: computeHealth is called with a stub prisma.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
}
interface ScreenRow {
  id: number;
  market: string;
  runAt: Date;
}

function stubPrisma(opts: { runs?: RunRow[]; screens?: ScreenRow[]; bars?: Record<string, string>; running?: RunRow[] } = {}) {
  const runs = opts.runs ?? [];
  const screens = opts.screens ?? [];
  const bars = opts.bars ?? {};
  const running = opts.running ?? [];
  return {
    deepDiveRun: {
      findFirst: async ({ where }: any) => {
        const pool = where.status === "running" ? running : runs;
        const match = pool
          .filter((r) => r.market === where.market)
          .filter((r) => (where.runAt?.lt ? r.runAt.getTime() < where.runAt.lt.getTime() : true))
          .sort((a, b) => b.runAt.getTime() - a.runAt.getTime());
        return match[0] ?? null;
      },
    },
    screenRun: {
      findFirst: async ({ where }: any) =>
        screens.filter((r) => r.market === where.market).sort((a, b) => b.runAt.getTime() - a.runAt.getTime())[0] ?? null,
    },
    bar: {
      findFirst: async ({ where }: any) => (bars[where.instrument.market] ? { date: bars[where.instrument.market] } : null),
    },
  } as any;
}

let reportsDir: string;

beforeAll(() => {
  reportsDir = mkdtempSync(path.join(tmpdir(), "ops-health-"));
});
afterAll(() => rmSync(reportsDir, { recursive: true, force: true }));

const lane = (r: HealthReport, m: "HK" | "US") => r.lanes.find((l) => l.market === m)!;

describe("computeHealth — lane cadence", () => {
  it("US: the real 2026-09-10 state (last complete run Sun 09-06) is ALERT with 3 missed", async () => {
    // Slots after Sun 09-06 21:16 HKT: Tue 09-08, Wed 09-09, Thu 09-10 at 06:10.
    const r = await computeHealth(
      stubPrisma({ runs: [{ id: 3, market: "US", runAt: hkt("2026-09-06T21:16:11") }] }),
      { now: hkt("2026-09-10T22:00:00"), reportsDir },
    );
    const us = lane(r, "US");
    expect(us.level).toBe("alert");
    expect(us.expectedRunsMissed).toBe(3);
  });

  it("US: a Saturday run is NOT stale by Tuesday (the Sat→Tue weekend gap)", async () => {
    // Sat 09-12 06:10 ran; the next slot is Tue 09-15 06:10, so on Sun 09-13
    // nothing is even due yet — the case pure age-in-hours got wrong.
    const r = await computeHealth(
      stubPrisma({ runs: [{ id: 9, market: "US", runAt: hkt("2026-09-12T06:15:00") }] }),
      { now: hkt("2026-09-13T20:00:00"), reportsDir },
    );
    expect(lane(r, "US").level).toBe("healthy");
    expect(lane(r, "US").expectedRunsMissed).toBe(0);
  });

  it("US: Monday 06:10 is not an expected US slot at all", async () => {
    // US runs Tue-Sat. A run on Sat 09-12 followed by now = Mon 09-14 must not
    // count Monday's 06:10 as missed.
    const r = await computeHealth(
      stubPrisma({ runs: [{ id: 9, market: "US", runAt: hkt("2026-09-12T06:15:00") }] }),
      { now: hkt("2026-09-14T12:00:00"), reportsDir },
    );
    expect(lane(r, "US").expectedRunsMissed).toBe(0);
  });

  it("HK: a slot inside the grace window is WARN, not ALERT (catch-up on wake)", async () => {
    // HK Thu 09-10 16:50 slot; now 19:00 is only 2.2h past — under the 6h
    // grace, so it must not count as missed at all.
    const r = await computeHealth(
      stubPrisma({ runs: [{ id: 6, market: "HK", runAt: hkt("2026-09-09T23:10:45") }] }),
      { now: hkt("2026-09-10T19:00:00"), reportsDir },
    );
    expect(lane(r, "HK").expectedRunsMissed).toBe(0);
    expect(lane(r, "HK").level).toBe("healthy");
  });

  it("HK: exactly one fully-elapsed slot is WARN with a catch-up reason", async () => {
    const r = await computeHealth(
      stubPrisma({ runs: [{ id: 6, market: "HK", runAt: hkt("2026-09-09T23:10:45") }] }),
      { now: hkt("2026-09-10T23:30:00"), reportsDir },
    );
    const hk = lane(r, "HK");
    expect(hk.expectedRunsMissed).toBe(1);
    expect(hk.level).toBe("warn");
    expect(hk.reasons.join(" ")).toMatch(/catch-up/);
  });

  it("HK: two fully-elapsed slots escalate to ALERT", async () => {
    // Last complete run Thu 09-09 23:10 → slots Thu 09-10 16:50, Fri 09-11
    // 16:50, Mon 09-14 16:50. (Mon-Fri only: Sat/Sun are not HK slots.)
    const r = await computeHealth(
      stubPrisma({ runs: [{ id: 6, market: "HK", runAt: hkt("2026-09-09T23:10:45") }] }),
      { now: hkt("2026-09-14T23:30:00"), reportsDir },
    );
    expect(lane(r, "HK").expectedRunsMissed).toBe(3);
    expect(lane(r, "HK").level).toBe("alert");
  });

  it("a lane with no complete run is ALERT and reports it plainly", async () => {
    const r = await computeHealth(stubPrisma(), { now: hkt("2026-09-10T22:00:00"), reportsDir });
    const us = lane(r, "US");
    expect(us.level).toBe("alert");
    expect(us.lastCompleteRunId).toBeNull();
    expect(us.reasons.join(" ")).toMatch(/no complete deep-dive run/);
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
        runs: [{ id: 6, market: "HK", runAt: hkt("2026-09-10T16:50:00") }],
        screens: [{ id: 14, market: "HK", runAt: hkt("2026-09-10T16:45:00") }],
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
    try {
      const r = await computeHealth(stubPrisma(), { now: hkt("2026-09-14T09:00:00"), reportsDir: empty });
      const f10 = r.jobs.find((j) => j.job === "f10")!;
      expect(f10.level).toBe("alert");
      expect(f10.lastArtifactDate).toBeNull();
      expect(f10.reasons.join(" ")).toMatch(/cannot confirm/);
      expect(f10.reasons.join(" ")).not.toMatch(/never run/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("a missing reports dir is handled, not thrown", async () => {
    const r = await computeHealth(stubPrisma(), { now: hkt("2026-09-14T09:00:00"), reportsDir: "/nonexistent/ops-health-test" });
    expect(r.jobs.every((j) => j.level === "alert")).toBe(true);
  });
});

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
