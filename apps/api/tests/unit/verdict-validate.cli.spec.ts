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
  SAMPLE_MODEL_STACK,
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
    expect(convictionOf('{"abstain":true,"conviction":0}')).toEqual({ conviction: null, abstain: true, promptVersion: null, models: null });
    expect(convictionOf("not json")).toEqual({ conviction: null, abstain: false, promptVersion: null, models: null });
    expect(convictionOf(null)).toEqual({ conviction: null, abstain: false, promptVersion: null, models: null });
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
    // The evening chain (20:30 HKT) screens the PREVIOUS US session, so runDate
    // is entry + 1 by construction. Anything stricter would discard every US verdict.
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
    expect(v).toEqual({ conviction: 0.4, abstain: false, promptVersion: "v1", models: null });
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
              { symbol: "AAA", verdictJson: JSON.stringify({ conviction: 0.5, rating: "buy", promptVersion: "v1", models: SAMPLE_MODEL_STACK }) },
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

  it("counts a FAILED deep-dive (verdictJson null) separately, not as a version mismatch", async () => {
    // convictionOf(null).promptVersion is null, and null !== "v1" — without a
    // separate counter a failed run is reported as "EXCLUDED (different prompt
    // version)", which it is not.
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
              { symbol: "AAA", verdictJson: JSON.stringify({ conviction: 0.5, rating: "buy", promptVersion: "v1", models: SAMPLE_MODEL_STACK }) },
              { symbol: "AAA", verdictJson: null },
            ],
          },
        ],
      },
    } as any;
    const r = await runValidation(prisma, { json: false, markets: ["US"], targetIc: 0.1 });
    expect(r.lanes[0]!.failedExcluded).toBe(1);
    expect(r.lanes[0]!.otherVersionExcluded).toBe(0);
    expect(renderValidation(r)).toMatch(/EXCLUDED \(deep-dive failed, no verdict\)/);
  });
});

describe("projection watch — the assumed sd is the number that says whether the horizon is real", () => {
  const stub = () =>
    ({
      instrument: { findMany: async () => [] },
      bar: { findMany: async () => [] },
      corporateAction: { findMany: async () => [] },
      deepDiveRun: { findMany: async () => [] },
    }) as any;

  it("says nothing while the sd is theoretical, then prints the measured/assumed ratio", async () => {
    // Phase 4b measured the assumed cross-sectional sd to be 1.31x (HK) to 2.16x
    // (US) too small, and daysNeeded is proportional to sd^2. daysNeeded already
    // rescales itself silently once 20 days exist; that rescaling is exactly what
    // a reader needs to see, so it is printed.
    const r = await runValidation(stub(), { json: false, markets: ["US"], targetIc: 0.1 });
    const lane = r.lanes[0]!;
    expect(lane.readiness.seSource).toBe("theoretical");
    expect(lane.sdTheory).toBeCloseTo(1 / Math.sqrt(39), 6); // breadth 40
    expect(renderValidation(r)).not.toMatch(/projection watch/);

    // 20+ days accrued: the harness now measures, so the ratio is printable.
    const theory = lane.sdTheory!;
    lane.readiness = { ...lane.readiness, seSource: "measured", daysNeeded: 546 };
    lane.sdDay = theory * 1.31;
    let text = renderValidation(r);
    expect(text).toMatch(/projection watch: per-day IC sd/);
    expect(text).toMatch(/1\.31x/);
    expect(text).toMatch(/daysNeeded rescaled to 546/);
    expect(text).not.toMatch(/!!/); // 1.31 is inside the observed 4b range

    // At the US lane's measured 2.16x the warning fires: the horizon is ~4.7x.
    lane.sdDay = theory * 2.16;
    text = renderValidation(r);
    expect(text).toMatch(/2\.16x/);
    expect(text).toMatch(/!!/);
  });
});

describe("provenance gate — an operator run is not a prospective observation", () => {
  it("excludes and counts an ad-hoc run, and keeps the scheduled one", async () => {
    // The defect this pins: verdict:validate selected every `status: "complete"`
    // run, so a hand-picked `--symbol` smoke entered the sample that decides H2.
    // ops/health.ts already pins `source: "chain"` for the dashboard; the
    // deciding statistic needs the same pin, or the cross-section is a selection.
    const mkRun = (id: number, source: string) => ({
      id,
      market: "US",
      runAt: new Date("2026-09-10T22:10:00Z"),
      source,
      reports: [
        { symbol: "AAA", verdictJson: JSON.stringify({ conviction: 0.5, rating: "buy", promptVersion: "v1", models: SAMPLE_MODEL_STACK }) },
      ],
    });
    const prisma = {
      instrument: { findMany: async () => [{ id: 1, symbol: "AAA" }] },
      bar: { findMany: async () => [{ instrumentId: 1, date: "2026-09-10", open: 1, high: 1, low: 1, close: 1, volume: 1 }] },
      corporateAction: { findMany: async () => [] },
      screenResult: { findMany: async () => [{ symbol: "AAA", rank: 1 }] },
      deepDiveRun: { findMany: async () => [mkRun(1, "chain"), mkRun(2, "adhoc")] },
    } as any;
    const r = await runValidation(prisma, { json: false, markets: ["US"], targetIc: 0.1 });
    expect(r.lanes[0]!.adhocExcluded).toBe(1);
    expect(r.lanes[0]!.pendingLabel).toBe(1); // only the chain verdict is even a candidate
    expect(renderValidation(r)).toMatch(/ad-hoc operator run/);
  });

  it("reads a row with no source as scheduled, since the column defaults to chain", async () => {
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
              { symbol: "AAA", verdictJson: JSON.stringify({ conviction: 0.5, promptVersion: "v1", models: SAMPLE_MODEL_STACK }) },
            ],
          },
        ],
      },
    } as any;
    const r = await runValidation(prisma, { json: false, markets: ["US"], targetIc: 0.1 });
    expect(r.lanes[0]!.adhocExcluded).toBe(0);
    expect(r.lanes[0]!.pendingLabel).toBe(1);
  });
});


describe("treatment gate — one model stack per sample (Phase-5 A6, re-baselined by A7)", () => {
  const FROZEN = { analyst: "deepseek-flash", debate: "deepseek-flash", verdict: "deepseek-flash" };

  it("pins the frozen stack to deepseek-flash on all three roles (A7 re-baseline)", () => {
    expect(SAMPLE_MODEL_STACK).toEqual(FROZEN);
  });

  it("reads the model stack from the verdict blob; a partial stack reads as absent", () => {
    const v = convictionOf(JSON.stringify({ conviction: 0.4, promptVersion: "v1", models: FROZEN }));
    expect(v.models).toEqual(FROZEN);
    expect(convictionOf(JSON.stringify({ conviction: 0.4, promptVersion: "v1", models: { analyst: "deepseek-flash" } })).models).toBeNull();
  });

  // A7 closes the k3 era rather than pooling it. Both halves are pinned here
  // because they are the whole content of the amendment: accrued k3 verdicts
  // stop counting, and the accrual lost is ~8-10 lane-days.
  it("excludes a k3-256k verdict written before the re-baseline instead of pooling it", async () => {
    const k3 = { analyst: "k3-256k", debate: "k3-256k", verdict: "k3-256k" };
    const prisma = stubWith([
      { symbol: "AAA", verdictJson: JSON.stringify({ conviction: 0.5, rating: "buy", promptVersion: "v1", models: k3 }) },
    ]);
    const r = await runValidation(prisma, { json: false, markets: ["US"], targetIc: 0.1 });
    const lane = r.lanes[0]!;
    expect(lane.otherModelExcluded).toBe(1);
    expect(lane.pendingLabel).toBe(0);
  });

  it("treats a pre-gate k3-256k verdict as unverifiable now that the stack moved", async () => {
    const decisions = ["h1", "h2", "h3", "h4", "h5", "h6", "h7"].map((hash) => ({ hash, model: "k3-256k" }));
    const prisma = stubWith([legacyVerdict(JSON.stringify(decisions.map((d) => d.hash)))], decisions);
    const r = await runValidation(prisma, { json: false, markets: ["US"], targetIc: 0.1 });
    const lane = r.lanes[0]!;
    expect(lane.legacyModelUnverifiable).toBe(1);
    expect(lane.legacyModelVerified).toBe(0);
    expect(lane.pendingLabel).toBe(0);
  });

  const stubWith = (reports: unknown[], decisions: { hash: string; model: string }[] = []) =>
    ({
      instrument: { findMany: async () => [{ id: 1, symbol: "AAA" }] },
      bar: { findMany: async () => [{ instrumentId: 1, date: "2026-09-10", open: 1, high: 1, low: 1, close: 1, volume: 1 }] },
      corporateAction: { findMany: async () => [] },
      screenResult: { findMany: async () => [{ symbol: "AAA", rank: 1 }] },
      agentDecision: { findMany: async () => decisions },
      deepDiveRun: {
        findMany: async () => [{ id: 1, market: "US", runAt: new Date("2026-09-10T22:10:00Z"), reports }],
      },
    }) as any;

  const legacyVerdict = (decisionHashesJson: string | null) => ({
    symbol: "AAA",
    verdictJson: JSON.stringify({ conviction: 0.5, rating: "buy", promptVersion: "v1" }),
    decisionHashesJson,
  });

  it("accepts a verdict carrying the frozen stack without touching the legacy path", async () => {
    const prisma = stubWith([
      { symbol: "AAA", verdictJson: JSON.stringify({ conviction: 0.5, rating: "buy", promptVersion: "v1", models: FROZEN }) },
    ]);
    const r = await runValidation(prisma, { json: false, markets: ["US"], targetIc: 0.1 });
    const lane = r.lanes[0]!;
    expect(lane.pendingLabel).toBe(1);
    expect(lane.otherModelExcluded).toBe(0);
    expect(lane.legacyModelVerified).toBe(0);
    expect(lane.legacyModelUnverifiable).toBe(0);
  });

  it("excludes and counts a verdict whose model stack differs on any role", async () => {
    const prisma = stubWith([
      {
        symbol: "AAA",
        verdictJson: JSON.stringify({ conviction: 0.5, rating: "buy", promptVersion: "v1", models: { ...FROZEN, verdict: "k4" } }),
      },
    ]);
    const r = await runValidation(prisma, { json: false, markets: ["US"], targetIc: 0.1 });
    const lane = r.lanes[0]!;
    expect(lane.otherModelExcluded).toBe(1);
    expect(lane.pendingLabel).toBe(0);
    expect(renderValidation(r)).toMatch(/EXCLUDED \(different model stack\)/);
  });

  it("verifies a pre-gate verdict against its AgentDecision rows and counts it legacyModelVerified", async () => {
    // 7 hashes = the full non-ETF call set; every one resolves to the frozen stack.
    const decisions = ["h1", "h2", "h3", "h4", "h5", "h6", "h7"].map((hash) => ({ hash, model: "deepseek-flash" }));
    const prisma = stubWith([legacyVerdict(JSON.stringify(decisions.map((d) => d.hash)))], decisions);
    const r = await runValidation(prisma, { json: false, markets: ["US"], targetIc: 0.1 });
    const lane = r.lanes[0]!;
    expect(lane.legacyModelVerified).toBe(1);
    expect(lane.legacyModelUnverifiable).toBe(0);
    expect(lane.pendingLabel).toBe(1);
    expect(renderValidation(r)).toMatch(/VERIFIED against the frozen model stack/);
  });

  it("verifies an ETF legacy verdict on the subset of roles present (no fundamentals hash)", async () => {
    // ETFs skip the fundamentals analyst, so the rule is "every hash PRESENT
    // verifies", never "every role is present".
    const decisions = ["h1", "h2", "h3", "h4", "h5", "h6"].map((hash) => ({ hash, model: "deepseek-flash" }));
    const prisma = stubWith([legacyVerdict(JSON.stringify(decisions.map((d) => d.hash)))], decisions);
    const r = await runValidation(prisma, { json: false, markets: ["US"], targetIc: 0.1 });
    expect(r.lanes[0]!.legacyModelVerified).toBe(1);
    expect(r.lanes[0]!.pendingLabel).toBe(1);
  });

  it("excludes a legacy verdict with an unresolvable hash rather than defaulting it", async () => {
    const decisions = [{ hash: "h1", model: "k3-256k" }];
    const prisma = stubWith([legacyVerdict(JSON.stringify(["h1", "h-missing"]))], decisions);
    const r = await runValidation(prisma, { json: false, markets: ["US"], targetIc: 0.1 });
    const lane = r.lanes[0]!;
    expect(lane.legacyModelUnverifiable).toBe(1);
    expect(lane.legacyModelVerified).toBe(0);
    expect(lane.pendingLabel).toBe(0);
    expect(renderValidation(r)).toMatch(/EXCLUDED \(legacy verdict, model stack unverifiable\)/);
  });

  it("excludes a legacy verdict whose recorded model is off the frozen stack", async () => {
    const decisions = [
      { hash: "h1", model: "deepseek-flash" },
      { hash: "h2", model: "deepseek-v4-pro" }, // exact match only — no equivalence rules
    ];
    const prisma = stubWith([legacyVerdict(JSON.stringify(["h1", "h2"]))], decisions);
    const r = await runValidation(prisma, { json: false, markets: ["US"], targetIc: 0.1 });
    expect(r.lanes[0]!.legacyModelUnverifiable).toBe(1);
    expect(r.lanes[0]!.pendingLabel).toBe(0);
  });

  it("excludes a legacy verdict with no decisionHashesJson at all", async () => {
    const prisma = stubWith([legacyVerdict(null)]);
    const r = await runValidation(prisma, { json: false, markets: ["US"], targetIc: 0.1 });
    expect(r.lanes[0]!.legacyModelUnverifiable).toBe(1);
    expect(r.lanes[0]!.pendingLabel).toBe(0);
  });
});
