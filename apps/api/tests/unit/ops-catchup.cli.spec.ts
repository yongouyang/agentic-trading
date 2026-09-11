/**
 * `ops:catchup` — the guard on the evening catch-up slot.
 *
 * The guard is the whole safety property: run when a session is missing, do
 * NOTHING when it is not. A guard that over-runs duplicates a session and inflates
 * the Phase-5 accrual; one that under-runs silently loses an observation.
 */
import { describe, expect, it } from "vitest";
import { NEEDS_RUN, decideLane, parseCatchupArgs, renderCatchup, runCatchup, type CatchupReport } from "../../src/cli/ops-catchup.js";

describe("ops:catchup — when to run", () => {
  it("runs when the store holds a session nobody screened", () => {
    const l = decideLane("US", "2026-09-11", "2026-09-10", null);
    expect(l.needsRun).toBe(true);
    expect(l.reason).toMatch(/one session behind/);
  });

  it("does NOT run when the newest session is already screened", () => {
    // The healthy-day case: this is what makes the second slot a no-op rather
    // than a duplicate run.
    const l = decideLane("HK", "2026-09-11", "2026-09-11", null);
    expect(l.needsRun).toBe(false);
    expect(l.reason).toMatch(/up to date/);
  });

  it("runs when the run ledger cannot say which session it screened", () => {
    // Pre-column rows carry ''. A duplicate costs minutes; a lost observation is
    // unrecoverable, so unknown fails toward running.
    expect(decideLane("US", "2026-09-11", null, null).needsRun).toBe(true);
  });

  it("does not run with no stored bars at all", () => {
    expect(decideLane("HK", null, null, null).needsRun).toBe(false);
  });

  it("is strictly ordered: equal dates are caught up, never re-run", () => {
    expect(decideLane("US", "2026-09-10", "2026-09-10", null).needsRun).toBe(false);
    expect(decideLane("US", "2026-09-09", "2026-09-10", null).needsRun).toBe(false); // store behind a run: not our problem
  });
});

describe("ops:catchup — surfaces", () => {
  it("parses flags and rejects junk", () => {
    expect(parseCatchupArgs([])).toEqual({ json: false, markets: ["US", "HK"] });
    expect(parseCatchupArgs(["--", "--json", "--lane", "hk"])).toEqual({ json: true, markets: ["HK"] });
    expect(() => parseCatchupArgs(["--lane", "cn"])).toThrow(/--lane must be us\|hk/);
    expect(() => parseCatchupArgs(["--nope"])).toThrow(/unknown argument/);
  });

  it("signals 'run' with a distinct exit code, not a failure code", async () => {
    // 10, so the shell can tell "behind" from "guard broken" — the script must not
    // blind-run on a guard error.
    expect(NEEDS_RUN).toBe(10);
    expect(NEEDS_RUN).not.toBe(0);
    expect(NEEDS_RUN).not.toBe(1);
  });

  it("renders a skip and a run clearly", () => {
    const r: CatchupReport = {
      asOf: "x",
      needsRun: true,
      lanes: [decideLane("US", "2026-09-11", "2026-09-10", null), decideLane("HK", "2026-09-11", "2026-09-11", null)],
    };
    const text = renderCatchup(r);
    expect(text).toMatch(/A LANE NEEDS A RUN/);
    expect(text).toMatch(/US: RUN/);
    expect(text).toMatch(/HK: skip/);
  });

  it("uses the newest run that RECORDS a session, not merely the newest run", async () => {
    // A legacy run (sessionDate '') sitting on top must not mask the real answer.
    const prisma = {
      bar: { findFirst: async () => ({ date: "2026-09-11" }) },
      screenRun: {
        findFirst: async ({ where }: any) =>
          where.sessionDate
            ? { sessionDate: "2026-09-11", runAt: new Date("2026-09-11T08:50:00Z") }
            : { sessionDate: "", runAt: new Date("2026-09-11T11:00:00Z") },
      },
    } as any;
    const r = await runCatchup(prisma, ["US"]);
    expect(r.lanes[0]!.needsRun).toBe(false);
    expect(r.needsRun).toBe(false);
  });
});
