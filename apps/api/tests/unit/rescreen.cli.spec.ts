/**
 * `screen:rescreen` — argument parsing, hole enumeration, and the refusal
 * cases (stub prisma). The PIT correctness of the recompute itself lives in
 * the throwaway-SQLite integration spec (tests/integration/rescreen.spec.ts);
 * it rests on quant-core's replay equivalence tests — the CLI wires to
 * `replayScreen` rather than re-deriving the slice.
 */
import { describe, expect, it } from "vitest";
import { PROSPECTIVE_FROM } from "../../src/cli/accrual.js";
import { enumerateHoles, parseRescreenArgs, rescreenSession } from "../../src/cli/rescreen.js";

describe("screen:rescreen — args", () => {
  it("requires --market and exactly one of --date / --holes", () => {
    expect(parseRescreenArgs(["--market", "hk", "--date", "2026-09-15"])).toEqual({ market: "hk", date: "2026-09-15", holes: false });
    expect(parseRescreenArgs(["--", "--market", "us", "--holes"])).toEqual({ market: "us", date: null, holes: true });
    expect(() => parseRescreenArgs(["--holes"])).toThrow(/--market us\|hk is required/);
    expect(() => parseRescreenArgs(["--market", "hk"])).toThrow(/one of --date/);
    expect(() => parseRescreenArgs(["--market", "hk", "--holes", "--date", "2026-09-15"])).toThrow(/mutually exclusive/);
    expect(() => parseRescreenArgs(["--market", "cn", "--holes"])).toThrow(/--market must be us\|hk/);
    expect(() => parseRescreenArgs(["--market", "hk", "--date", "09/15/2026"])).toThrow(/YYYY-MM-DD/);
    expect(() => parseRescreenArgs(["--market", "hk", "--nope"])).toThrow(/unknown argument/);
  });
});

describe("screen:rescreen — hole enumeration", () => {
  const NOW = new Date("2026-09-16T10:00:00+08:00"); // the HK 09-16 session is still forming
  const stub = (dates: string[], screened: string[]) =>
    ({
      bar: { findMany: async () => dates.map((date) => ({ date })) },
      screenRun: { findMany: async () => screened.map((sessionDate) => ({ sessionDate })) },
    }) as any;

  it("mixed screened/unscreened sessions; pre-cutoff and unclosed excluded", async () => {
    const holes = await enumerateHoles(
      stub(["2026-09-11", "2026-09-12", "2026-09-14", "2026-09-15", "2026-09-16"], ["2026-09-14"]),
      "HK",
      NOW,
    );
    expect(holes).toEqual(["2026-09-12", "2026-09-15"]);
    // 09-11 < PROSPECTIVE_FROM (spent window), 09-14 already has a ScreenRun,
    // and 09-16 is still forming at NOW (HK close is 16:10 HKT).
    expect(PROSPECTIVE_FROM).toBe("2026-09-12");
  });

  it("no store sessions past the cutoff ⇒ no holes", async () => {
    expect(await enumerateHoles(stub(["2026-09-10", "2026-09-11"], []), "HK", NOW)).toEqual([]);
  });

  it("an unclosed US session is excluded too (16:00 America/New_York)", async () => {
    // 2026-09-16 10:00 HKT = 2026-09-15 22:00 EDT: the 09-15 US session has
    // closed, a 09-16 US bar would not have.
    const holes = await enumerateHoles(stub(["2026-09-15"], []), "US", NOW);
    expect(holes).toEqual(["2026-09-15"]);
  });
});

describe("screen:rescreen — refusals (nothing is written)", () => {
  const NOW = new Date("2026-09-16T20:00:00+08:00"); // everything through 09-16 closed, both lanes
  const stub = (opts: { barsAtDate?: boolean; existingRunId?: number }) =>
    ({
      instrument: { findMany: async () => [{ id: 1, symbol: "0005.HK", market: "HK", caDegraded: false }] },
      bar: { findFirst: async () => (opts.barsAtDate ? { instrumentId: 1 } : null) },
      screenRun: {
        findFirst: async () => (opts.existingRunId ? { id: opts.existingRunId, source: "chain" } : null),
      },
    }) as any;

  it("T < PROSPECTIVE_FROM — the window is spent, no prospective value", async () => {
    await expect(rescreenSession(stub({ barsAtDate: true }), "HK", "2026-09-11", NOW)).rejects.toThrow(/PROSPECTIVE_FROM/);
  });

  it("T is not yet a completed session", async () => {
    await expect(rescreenSession(stub({ barsAtDate: true }), "HK", "2026-09-16", new Date("2026-09-16T10:00:00+08:00"))).rejects.toThrow(
      /not yet completed/,
    );
  });

  it("no bars in the store for T", async () => {
    await expect(rescreenSession(stub({ barsAtDate: false }), "HK", "2026-09-15", NOW)).rejects.toThrow(/no bars/);
  });

  it("a ScreenRun already covers T (dedup by sessionDate — the accrual rule)", async () => {
    await expect(rescreenSession(stub({ barsAtDate: true, existingRunId: 42 }), "HK", "2026-09-15", NOW)).rejects.toThrow(
      /already covers this session/,
    );
  });
});
