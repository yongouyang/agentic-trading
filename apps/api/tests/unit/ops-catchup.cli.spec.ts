/**
 * `ops:catchup` — the guard on the evening catch-up slot.
 *
 * The guard is the whole safety property: run when a session is missing, do
 * NOTHING when it is not. A guard that over-runs duplicates a session and inflates
 * the Phase-5 accrual; one that under-runs silently loses an observation.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DataOutcome } from "@agentic-trading/quant-core";
import {
  NEEDS_RUN,
  decideLane,
  makeExpectedSessionProbe,
  parseCatchupArgs,
  renderCatchup,
  runCatchup,
  type CatchupReport,
} from "../../src/cli/ops-catchup.js";

describe("ops:catchup — when to run", () => {
  it("runs when the store holds a session nobody screened", () => {
    const l = decideLane("US", "2026-09-11", "2026-09-10", null, true, null);
    expect(l.needsRun).toBe(true);
    expect(l.reason).toMatch(/SCREEN leg one session behind/);
  });

  it("does NOT run when the newest session is screened AND chain-deep-dived", () => {
    // The healthy-day case: this is what makes the second slot a no-op rather
    // than a duplicate run.
    const l = decideLane("HK", "2026-09-11", "2026-09-11", null, true, null);
    expect(l.needsRun).toBe(false);
    expect(l.reason).toMatch(/up to date/);
  });

  it("runs when the screen is current but the chain deep-dive never ran", () => {
    // The 2026-09-12 production miss: HK screened 09-11, machine off for both
    // chain slots, no chain deep-dive attached — screen-only logic said
    // "up to date" and the verdict leg stayed permanently behind.
    const l = decideLane("HK", "2026-09-11", "2026-09-11", null, false, null);
    expect(l.needsRun).toBe(true);
    expect(l.reason).toMatch(/DEEP-DIVE leg behind/);
  });

  it("screen-behind wins regardless of the deep-dive state", () => {
    const l = decideLane("US", "2026-09-11", "2026-09-10", null, false, null);
    expect(l.needsRun).toBe(true);
    expect(l.reason).toMatch(/SCREEN leg/);
  });

  it("runs when the run ledger cannot say which session it screened", () => {
    // Pre-column rows carry ''. A duplicate costs minutes; a lost observation is
    // unrecoverable, so unknown fails toward running.
    expect(decideLane("US", "2026-09-11", null, null, null, null).needsRun).toBe(true);
  });

  it("does not run with no stored bars at all", () => {
    expect(decideLane("HK", null, null, null, null, null).needsRun).toBe(false);
  });

  it("is strictly ordered: equal dates are caught up, never re-run", () => {
    expect(decideLane("US", "2026-09-10", "2026-09-10", null, true, null).needsRun).toBe(false);
    expect(decideLane("US", "2026-09-09", "2026-09-10", null, true, null).needsRun).toBe(false); // store behind a run: not our problem
  });
});

describe("ops:catchup — the expected-session probe (2026-09-14)", () => {
  // The 2026-09-14 incident: machine powered off all day, nothing fetched, so
  // latestBar == lastScreened and the store legs read "up to date" while that
  // day's completed HK session went unscreened. The probe asks the PROVIDER
  // which sessions are complete, so it fires even when the store is stale —
  // or empty.

  it("runs when the probe sees a completed session newer than last screened — even with a stale store", () => {
    const l = decideLane("HK", "2026-09-11", "2026-09-11", null, true, "2026-09-14");
    expect(l.needsRun).toBe(true);
    expect(l.reason).toMatch(/session 2026-09-14 complete but only screened through 2026-09-11/);
    expect(l.reason).toMatch(/probe, not store/);
    expect(l.expectedSession).toBe("2026-09-14");
  });

  it("runs when the probe sees a completed session and the store is EMPTY (the incident shape)", () => {
    const l = decideLane("HK", null, null, null, null, "2026-09-14");
    expect(l.needsRun).toBe(true);
    expect(l.reason).toMatch(/screened through nothing/);
  });

  it("does NOT run when the probe's expected session equals last screened", () => {
    const l = decideLane("HK", "2026-09-14", "2026-09-14", null, true, "2026-09-14");
    expect(l.needsRun).toBe(false);
    expect(l.reason).toMatch(/up to date/);
  });

  it("does NOT run when the probe is BEHIND last screened (a rescreen healed ahead of the provider's newest close)", () => {
    const l = decideLane("US", "2026-09-11", "2026-09-11", null, true, "2026-09-10");
    expect(l.needsRun).toBe(false);
  });

  it("a null probe answer preserves the pre-probe behaviour exactly", () => {
    // Stale-looking-but-equal store + null probe ⇒ the old "up to date".
    expect(decideLane("HK", "2026-09-11", "2026-09-11", null, true, null).needsRun).toBe(false);
    // And the old blind spot stays blind without the probe (regression pin).
    expect(decideLane("HK", "2026-09-11", "2026-09-11", null, true, null).reason).toMatch(/up to date/);
  });

  it("the probe leg wins over every store leg (screen current + deep-dive done still runs)", () => {
    const l = decideLane("US", "2026-09-11", "2026-09-11", null, true, "2026-09-12");
    expect(l.needsRun).toBe(true);
    expect(l.reason).toMatch(/probe, not store/);
  });

  it("runCatchup wires the probe's answer into the decision", async () => {
    const prisma = {
      bar: { findFirst: async () => ({ date: "2026-09-11" }) },
      screenRun: {
        findFirst: async () => ({ id: 18, sessionDate: "2026-09-11", runAt: new Date("2026-09-11T08:50:00Z") }),
      },
      deepDiveRun: { findFirst: async () => ({ id: 7, topN: 40, failed: 0 }) },
    } as any;
    const withoutProbe = await runCatchup(prisma, ["HK"]);
    expect(withoutProbe.lanes[0]!.needsRun).toBe(false);
    expect(withoutProbe.lanes[0]!.expectedSession).toBeNull();

    const withProbe = await runCatchup(prisma, ["HK"], async () => "2026-09-14");
    expect(withProbe.lanes[0]!.expectedSession).toBe("2026-09-14");
    expect(withProbe.lanes[0]!.needsRun).toBe(true);
    expect(withProbe.needsRun).toBe(true);

    // A probe that FAILED (null) must not change the store-only verdict.
    const failedProbe = await runCatchup(prisma, ["HK"], async () => null);
    expect(failedProbe.lanes[0]!.needsRun).toBe(false);
  });
});

describe("ops:catchup — makeExpectedSessionProbe", () => {
  function fixtureUniverse(symbols: string[]): string {
    const dir = mkdtempSync(path.join(tmpdir(), "catchup-probe-"));
    writeFileSync(
      path.join(dir, "universe.hk.json"),
      JSON.stringify({ symbols: symbols.map((s) => ({ symbol: s, name: s, currency: "HKD", kind: "stock" })) }),
    );
    return dir;
  }

  const ok = (symbol: string, dates: string[]) =>
    ({
      symbol,
      outcome: DataOutcome.OK,
      bars: dates.map((d) => ({ date: d, open: 1, high: 1, low: 1, close: 1, volume: 1 })),
      corporateActions: [],
      droppedPhantomBars: [],
      repairedBars: [],
      droppedNullBars: [],
      levelBreakDropped: [],
      levelBreakWarnings: [],
      caDegraded: false,
      splitCount: 0,
    }) as any;

  it("returns the max CLOSED bar date across the probe names; a still-forming bar never counts", async () => {
    // 2026-09-14 21:00 HKT: HK's 09-14 session closed 16:10 HKT; a 09-15 bar
    // (data glitch) is not closed and must be excluded.
    const now = new Date("2026-09-14T13:00:00Z");
    const service = {
      getDailyBars: async (symbol: string) =>
        symbol === "0700.HK" ? ok(symbol, ["2026-09-11", "2026-09-14", "2026-09-15"]) : ok(symbol, ["2026-09-12"]),
    };
    const probe = makeExpectedSessionProbe(service, now, fixtureUniverse(["0700.HK", "0005.HK", "0941.HK", "1299.HK"]));
    expect(await probe("HK")).toBe("2026-09-14");
  });

  it("skips failed names and non-OK outcomes; total failure degrades to null", async () => {
    const now = new Date("2026-09-14T13:00:00Z");
    const service = {
      getDailyBars: async (symbol: string) => {
        if (symbol === "0700.HK") throw new Error("http-429");
        if (symbol === "0005.HK") return { ...ok(symbol, []), outcome: DataOutcome.FETCH_FAILED };
        return ok(symbol, ["2026-09-11"]);
      },
    };
    const probe = makeExpectedSessionProbe(service, now, fixtureUniverse(["0700.HK", "0005.HK", "0941.HK"]));
    expect(await probe("HK")).toBe("2026-09-11");

    const allBroken = makeExpectedSessionProbe(
      { getDailyBars: async () => Promise.reject(new Error("down")) },
      now,
      fixtureUniverse(["0700.HK"]),
    );
    expect(await allBroken("HK")).toBeNull();
  });

  it("probes only the first PROBE_SYMBOLS names of the lane's universe", async () => {
    const seen: string[] = [];
    const service = {
      getDailyBars: async (symbol: string) => {
        seen.push(symbol);
        return ok(symbol, ["2026-09-11"]);
      },
    };
    const probe = makeExpectedSessionProbe(service, new Date("2026-09-14T13:00:00Z"), fixtureUniverse(["a", "b", "c", "d"]));
    await probe("HK");
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("an unreadable universe file yields null, never a throw", async () => {
    const probe = makeExpectedSessionProbe({ getDailyBars: async () => ok("x", ["2026-09-11"]) }, new Date(), "/nonexistent");
    expect(await probe("HK")).toBeNull();
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
      lanes: [
        decideLane("US", "2026-09-11", "2026-09-10", null, true, null),
        decideLane("HK", "2026-09-11", "2026-09-11", null, true, null),
      ],
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
            ? { id: 18, sessionDate: "2026-09-11", runAt: new Date("2026-09-11T08:50:00Z") }
            : { id: 19, sessionDate: "", runAt: new Date("2026-09-11T11:00:00Z") },
      },
      deepDiveRun: { findFirst: async () => ({ id: 7, topN: 40, failed: 0 }) }, // a complete chain deep-dive exists
    } as any;
    const r = await runCatchup(prisma, ["US"]);
    expect(r.lanes[0]!.needsRun).toBe(false);
    expect(r.needsRun).toBe(false);
  });
});

describe("ops:catchup — the verdict leg (provenance)", () => {  /** Stub store: screen current through 09-11; deepDiveRun rows filtered the
   *  way Prisma would (status + source + attached screenRunId). `topN`/`failed`
   *  default to a fully-successful 40-name leg; a test that cares about the
   *  zero-verdict case (`deepDiveCovers`, 2026-09-16) passes them explicitly. */
  function stubWithDeepDives(deepDives: { screenRunId: number; status: string; source: string; topN?: number; failed?: number }[]) {
    return {
      bar: { findFirst: async () => ({ date: "2026-09-11" }) },
      screenRun: {
        findFirst: async () => ({ id: 18, sessionDate: "2026-09-11", runAt: new Date("2026-09-11T08:50:00Z") }),
      },
      deepDiveRun: {
        findFirst: async ({ where }: any) => {
          const hit = deepDives.find(
            (d) =>
              d.screenRunId === where.screenRunId &&
              (!where.status || d.status === where.status) &&
              (!where.source || d.source === where.source),
          );
          return hit ? { topN: 40, failed: 0, ...hit } : null;
        },
      },
    } as any;
  }

  it("screen current + complete chain deep-dive → up to date", async () => {
    const r = await runCatchup(stubWithDeepDives([{ screenRunId: 18, status: "complete", source: "chain" }]), ["HK"]);
    expect(r.lanes[0]!.needsRun).toBe(false);
  });

  // 2026-09-16: `complete` is written even when every name failed, so a run with
  // zero verdicts must leave the lane BEHIND — otherwise the sample stops
  // accruing while the guard reports "up to date". A partial failure is the
  // opposite call: the leg ran, so it must NOT trigger a re-run loop.
  it("a chain deep-dive that produced ZERO verdicts leaves the lane behind", async () => {
    const r = await runCatchup(
      stubWithDeepDives([{ screenRunId: 18, status: "complete", source: "chain", topN: 40, failed: 40 }]),
      ["HK"],
    );
    expect(r.lanes[0]!.needsRun).toBe(true);
    expect(r.lanes[0]!.reason).toMatch(/DEEP-DIVE leg behind/);
  });

  it("a partially failed chain deep-dive still counts as coverage (no re-run loop)", async () => {
    const r = await runCatchup(
      stubWithDeepDives([{ screenRunId: 18, status: "complete", source: "chain", topN: 40, failed: 3 }]),
      ["HK"],
    );
    expect(r.lanes[0]!.needsRun).toBe(false);
  });

  it("a lane with no picks that evening is covered, not behind forever", async () => {
    const r = await runCatchup(
      stubWithDeepDives([{ screenRunId: 18, status: "complete", source: "chain", topN: 0, failed: 0 }]),
      ["HK"],
    );
    expect(r.lanes[0]!.needsRun).toBe(false);
  });

  it("screen current + NO deep-dive → behind on the DEEP-DIVE leg", async () => {
    const r = await runCatchup(stubWithDeepDives([]), ["HK"]);
    expect(r.lanes[0]!.needsRun).toBe(true);
    expect(r.lanes[0]!.reason).toMatch(/DEEP-DIVE leg behind/);
  });

  it("screen current + only an AD-HOC deep-dive → still behind", async () => {
    // Provenance is the whole point: an operator's smoke run must not satisfy
    // the guard.
    const r = await runCatchup(stubWithDeepDives([{ screenRunId: 18, status: "complete", source: "adhoc" }]), ["HK"]);
    expect(r.lanes[0]!.needsRun).toBe(true);
    expect(r.lanes[0]!.reason).toMatch(/DEEP-DIVE leg behind/);
  });

  it("a crashed chain deep-dive (status 'running') does not count either", async () => {
    const r = await runCatchup(stubWithDeepDives([{ screenRunId: 18, status: "running", source: "chain" }]), ["HK"]);
    expect(r.lanes[0]!.needsRun).toBe(true);
  });

  it("adhoc + chain both present → up to date", async () => {
    const r = await runCatchup(
      stubWithDeepDives([
        { screenRunId: 18, status: "complete", source: "adhoc" },
        { screenRunId: 18, status: "complete", source: "chain" },
      ]),
      ["HK"],
    );
    expect(r.lanes[0]!.needsRun).toBe(false);
  });

  it("a chain deep-dive attached to an OLDER screen run does not heal the newest one", async () => {
    const r = await runCatchup(stubWithDeepDives([{ screenRunId: 5, status: "complete", source: "chain" }]), ["HK"]);
    expect(r.lanes[0]!.needsRun).toBe(true);
  });
});

describe("ops:catchup — rescreen rows must not make the lane read as behind", () => {
  // 2026-09-13: a screen:rescreen row carries a FRESH runAt and an OLD
  // sessionDate. lastScreened is the MAX sessionDate across the lane's runs —
  // ordering by runAt would report the rescreened hole as the newest screened
  // session and re-trigger a run for sessions the chain already covered.
  const screens = [
    { id: 18, sessionDate: "2026-09-11", runAt: new Date("2026-09-11T08:50:00Z"), source: "chain" },
    { id: 19, sessionDate: "2026-09-09", runAt: new Date("2026-09-13T02:00:00Z"), source: "rescreen" }, // newest by runAt
  ];
  const prisma = {
    bar: { findFirst: async () => ({ date: "2026-09-11" }) },
    screenRun: {
      findFirst: async ({ where, orderBy }: any) => {
        const pool = screens.filter((r) => (where?.sessionDate?.not === "" ? r.sessionDate !== "" : true));
        const bySession = Array.isArray(orderBy) && orderBy.some((o: any) => o.sessionDate);
        const sorted = [...pool].sort((a, b) =>
          bySession
            ? b.sessionDate.localeCompare(a.sessionDate) || b.runAt.getTime() - a.runAt.getTime()
            : b.runAt.getTime() - a.runAt.getTime(),
        );
        return sorted[0] ?? null;
      },
    },
    deepDiveRun: {
      // The chain verdict is attached to the run that screened 09-11.
      findFirst: async ({ where }: any) =>
        where.screenRunId === 18 && where.status === "complete" && where.source === "chain"
          ? { id: 7, topN: 40, failed: 0 }
          : null,
    },
  } as any;

  it("lastScreened is the max sessionDate, and the verdict leg reads that session's run", async () => {
    const r = await runCatchup(prisma, ["HK"]);
    expect(r.lanes[0]!.lastScreened).toBe("2026-09-11");
    expect(r.lanes[0]!.needsRun).toBe(false);
    expect(r.lanes[0]!.reason).toMatch(/up to date/);
    // lastRunAt reports the run that ANSWERED the question (the existing
    // behaviour: the ''-fallback only fires when no run records a session).
    expect(r.lanes[0]!.lastRunAt).toBe("2026-09-11T08:50:00.000Z");
  });
});
