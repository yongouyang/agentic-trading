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
    expect(convictionOf('{"abstain":true,"conviction":0}')).toEqual({ conviction: null, abstain: true });
    expect(convictionOf("not json")).toEqual({ conviction: null, abstain: false });
    expect(convictionOf(null)).toEqual({ conviction: null, abstain: false });
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
