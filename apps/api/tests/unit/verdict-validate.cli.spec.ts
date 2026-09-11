/**
 * `verdict:validate` — Phase 5. The CLI is thin; what matters is that it parses
 * its bar, picks the entry date PIT-correctly, and SKIPS abstains rather than
 * scoring a decision nobody made.
 */
import { describe, expect, it } from "vitest";
import {
  convictionOf,
  daysBetweenIso,
  MAX_PROMPT_LAG_DAYS,
  SAMPLE_PROMPT_VERSION,
  entryDate,
  hktDate,
  parseValidateArgs,
  renderValidation,
  runValidation,
  DEFAULT_TARGET_IC,
  type ValidationReport,
} from "../../src/cli/verdict-validate.js";

describe("verdict:validate — surfaces", () => {
  it("parses flags and rejects junk", () => {
    expect(parseValidateArgs([])).toEqual({ json: false, markets: ["US", "HK"], targetIc: DEFAULT_TARGET_IC });
    expect(parseValidateArgs(["--", "--json", "--lane", "hk"])).toEqual({ json: true, markets: ["HK"], targetIc: DEFAULT_TARGET_IC });
    expect(parseValidateArgs(["--target-ic", "0.2"]).targetIc).toBe(0.2);
    expect(() => parseValidateArgs(["--lane", "cn"])).toThrow(/--lane must be us\|hk/);
    expect(() => parseValidateArgs(["--target-ic", "-1"])).toThrow(/positive number/);
    expect(() => parseValidateArgs(["--nope"])).toThrow(/unknown argument/);
  });

  it("hktDate is the HKT calendar date", () => {
    expect(hktDate(new Date("2026-09-11T17:00:00Z"))).toBe("2026-09-12");
    expect(hktDate(new Date("2026-09-11T15:00:00Z"))).toBe("2026-09-11");
  });

  it("entryDate picks the newest bar date at or before the run, never a future one", () => {
    const dates = ["2026-09-08", "2026-09-09", "2026-09-10"];
    expect(entryDate(dates, "2026-09-11")).toBe("2026-09-10");
    expect(entryDate(dates, "2026-09-09")).toBe("2026-09-09");
    expect(entryDate(dates, "2026-09-01")).toBeNull();
  });

  it("reads conviction, and treats an abstain as a non-opinion rather than a 0", () => {
    expect(convictionOf('{"conviction":0.45}').conviction).toBe(0.45);
    expect(convictionOf('{"abstain":true,"conviction":0}')).toEqual({ conviction: null, abstain: true, promptVersion: null });
    expect(convictionOf("not json")).toEqual({ conviction: null, abstain: false, promptVersion: null });
    expect(convictionOf(null)).toEqual({ conviction: null, abstain: false, promptVersion: null });
  });

  it("reports both lanes and a pooled row against a stub store", async () => {
    const prisma = {
      instrument: { findMany: async () => [] },
      bar: { findMany: async () => [] },
      corporateAction: { findMany: async () => [] },
      deepDiveRun: { findMany: async () => [] },
    } as any;
    const r: ValidationReport = await runValidation(prisma, { json: false, markets: ["US", "HK"], targetIc: 0.1 });
    expect(r.lanes.map((l) => l.market)).toEqual(["US", "HK"]);
    expect(r.pooled.market).toBe("POOLED");
    for (const l of [...r.lanes, r.pooled]) {
      expect(l.verdict).toBe("insufficient_evidence");
      expect(l.readiness.decidable).toBe(false);
    }
    // Pooling must halve the projected horizon — that is the whole point of Fork C.
    expect(r.pooled.readiness.daysNeeded).toBeLessThan(r.lanes[0]!.readiness.daysNeeded);
    const text = renderValidation(r);
    expect(text).toMatch(/insufficient_evidence/);
    expect(text).toMatch(/not evidence of no edge/);
  });
});

describe("promptness gate — a late run is look-ahead, not an observation", () => {
  it("treats the US lane's own next-morning convention as prompt", () => {
    // daily-us runs 06:10 HKT on the morning after the US close, so runDate is
    // entry + 1 by construction. Anything stricter would discard every US verdict.
    expect(MAX_PROMPT_LAG_DAYS).toBe(1);
    expect(daysBetweenIso("2026-09-10", "2026-09-11")).toBe(1);
  });

  it("counts calendar days, including the weekend gap", () => {
    // The real case: the 2026-09-06 Sunday smoke runs screened Friday 09-04.
    expect(daysBetweenIso("2026-09-04", "2026-09-06")).toBe(2);
    expect(daysBetweenIso("2026-09-04", "2026-09-04")).toBe(0);
    expect(daysBetweenIso("2026-09-11", "2026-09-04")).toBe(-7);
  });

  it("rejects a Sunday catch-up of a Friday session but accepts a same-day or next-day run", () => {
    const lag = (screened: string, ran: string) => daysBetweenIso(screened, ran);
    expect(lag("2026-09-11", "2026-09-11") <= MAX_PROMPT_LAG_DAYS).toBe(true);  // HK normal slot
    expect(lag("2026-09-10", "2026-09-11") <= MAX_PROMPT_LAG_DAYS).toBe(true);  // US normal slot
    expect(lag("2026-09-11", "2026-09-12") <= MAX_PROMPT_LAG_DAYS).toBe(true);  // Sat catch-up of Friday HK
    expect(lag("2026-09-04", "2026-09-06") <= MAX_PROMPT_LAG_DAYS).toBe(false); // Sunday run, Friday session
  });
});

describe("treatment gate — one prompt version per sample", () => {
  it("reads the version from the verdict blob, because the table has no such column", () => {
    // DeepDiveReport stores only verdictJson. Reading a promptVersion column
    // (which does not exist) would exclude EVERY verdict, emptying the sample
    // without an error — so this is pinned rather than assumed.
    const v = convictionOf(JSON.stringify({ conviction: 0.4, abstain: false, promptVersion: "v1" }));
    expect(v).toEqual({ conviction: 0.4, abstain: false, promptVersion: "v1" });
    expect(convictionOf(JSON.stringify({ conviction: 0.4, abstain: false })).promptVersion).toBeNull();
  });

  it("keeps the abstain signal alongside the version", () => {
    const v = convictionOf(JSON.stringify({ abstain: true, conviction: 0, promptVersion: "v1" }));
    expect(v.abstain).toBe(true);
    expect(v.conviction).toBeNull();
    expect(v.promptVersion).toBe("v1");
  });

  it("samples the SHIPPED version", () => {
    expect(SAMPLE_PROMPT_VERSION).toBe("v1");
  });

  it("reports a different version as excluded rather than pooling two treatments", async () => {
    const prisma = {
      instrument: { findMany: async () => [{ id: 1, symbol: "AAA" }] },
      bar: { findMany: async () => [{ instrumentId: 1, date: "2026-09-10", open: 1, high: 1, low: 1, close: 1, volume: 1 }] },
      corporateAction: { findMany: async () => [] },
      screenResult: { findMany: async () => [{ symbol: "AAA", rank: 1 }] },
      deepDiveRun: {
        findMany: async () => [
          {
            id: 1,
            market: "US",
            runAt: new Date("2026-09-10T22:10:00Z"),
            reports: [
              { symbol: "AAA", verdictJson: JSON.stringify({ conviction: 0.5, rating: "buy", promptVersion: "v1" }) },
              { symbol: "AAA", verdictJson: JSON.stringify({ conviction: 0.5, rating: "buy", promptVersion: "v2" }) },
            ],
          },
        ],
      },
    } as any;
    const r = await runValidation(prisma, { json: false, markets: ["US"], targetIc: 0.1 });
    expect(r.lanes[0]!.otherVersionExcluded).toBe(1);
    expect(r.lanes[0]!.pendingLabel).toBe(1); // only the v1 verdict is even a candidate
  });
});
