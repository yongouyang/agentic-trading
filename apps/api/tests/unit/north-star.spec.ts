/**
 * Phase 6A / metric lock — the hypothesis register readout.
 *
 * Two blocks matter most. The **artifact checks** are what make a declared register
 * worth more than a derived one: they catch a pointer that does not resolve, a value
 * transcribed wrong, and a genuine disagreement between the governing class and the
 * artifact — each of which would otherwise be invisible in a summary line. And the
 * **live register** block runs the checked-in `docs/hypothesis-register.json` through
 * both the schema and the artifact checks, so a future edit that breaks it fails here
 * rather than silently changing what L2's completion condition reads.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REGISTER_FILE,
  checkArtifacts,
  locateAll,
  measureSupply,
  parseNorthStarArgs,
  projectDate,
  projectLevel,
  renderNorthStar,
  validateRegister,
  type HypothesisRegister,
  type LiveReading,
  type NorthStarReport,
} from "../../src/cli/north-star.js";

const row = (over: Partial<HypothesisRegister["hypotheses"][number]> = {}) => ({
  id: "X",
  title: "t",
  statistic: "s",
  universe: "u",
  window: "w",
  bar: "b",
  barLockedAt: "2026-01-01",
  barDoc: "d.md",
  state: "retired" as const,
  class: "underpowered" as const,
  classAt: "2026-01-02",
  classDoc: "d.md",
  artifact: "artifact.json",
  artifactClassLocator: "lane.verdict",
  artifactClass: "underpowered" as const,
  ...over,
});
const reg = (rows: ReturnType<typeof row>[]): HypothesisRegister => ({ version: 1, metricDoc: "m", metricLockedAt: "2026-01-01", hypotheses: rows as HypothesisRegister["hypotheses"] });

describe("locator", () => {
  it("addresses scalars, nested scalars and every element of an array", () => {
    const obj = { lane: { verdict: "a" }, lanes: [{ verdict: "b" }, { verdict: "c" }], deep: [{ inner: { v: 1 } }, { inner: { v: 2 } }] };
    expect(locateAll(obj, "lane.verdict")).toEqual(["a"]);
    // The [] step must map over ALL elements: a two-lane artifact checked only
    // against its first lane would pass while the second disagreed.
    expect(locateAll(obj, "lanes[].verdict")).toEqual(["b", "c"]);
    expect(locateAll(obj, "deep[].inner.v")).toEqual([1, 2]);
  });

  it("returns nothing rather than throwing on a path that does not exist", () => {
    expect(locateAll({ a: 1 }, "b.c")).toEqual([]);
    expect(locateAll(null, "a")).toEqual([]);
    expect(locateAll({ a: [{ b: 1 }] }, "a[].c")).toEqual([]);
  });
});

describe("register schema", () => {
  it("accepts a well-formed live row and a well-formed retired row", () => {
    expect(validateRegister(reg([row({ state: "live", clock: "gating", class: undefined, classAt: undefined, classDoc: undefined }) as never]))).toEqual([]);
    expect(validateRegister(reg([row()]))).toEqual([]);
  });

  it("requires the bar provenance on every row — a bar with no lock date is not pre-registered", () => {
    for (const field of ["bar", "barLockedAt", "barDoc", "statistic", "universe", "window"] as const) {
      const errors = validateRegister(reg([row({ [field]: "" })]));
      expect(errors.join(" ")).toContain(field);
    }
  });

  it("rejects a duplicate id, a bad state, and a live row without a clock", () => {
    expect(validateRegister(reg([row({ id: "A" }), row({ id: "A" })])).join(" ")).toContain("duplicate id");
    expect(validateRegister(reg([row({ state: "paused" } as never)])).join(" ")).toContain("live|retired");
    expect(validateRegister(reg([row({ state: "live" })])).join(" ")).toContain("clock gating|accruing-only");
  });

  it("requires a retired row to carry a class from the fixed five", () => {
    expect(validateRegister(reg([row({ class: undefined })])).join(" ")).toContain("needs a class");
    expect(validateRegister(reg([row({ class: "h1_revised" } as never)])).join(" ")).toContain("outside the fixed five-class vocabulary");
  });

  it("demands a reason when the artifact cannot be checked or disagrees", () => {
    // No locator at all: nothing machine-checkable backs the class, so the row must
    // say how it was established.
    expect(validateRegister(reg([row({ artifactClassLocator: undefined, artifactClass: undefined })])).join(" ")).toContain("divergenceReason");
    // A locator that agrees needs nothing…
    expect(validateRegister(reg([row({ artifactClassLocator: "lane.verdict", artifactClass: "underpowered" })]))).toEqual([]);
    // …and one that disagrees needs the reason.
    expect(validateRegister(reg([row({ artifactClassLocator: "lane.verdict", artifactClass: "insufficient_evidence" })])).join(" ")).toContain("divergenceReason");
  });
});

describe("artifact checks", () => {
  const root = mkdtempSync(path.join(tmpdir(), "north-star-"));
  const artifact = (name: string, body: unknown) => {
    mkdirSync(path.join(root, path.dirname(name)), { recursive: true });
    writeFileSync(path.join(root, name), JSON.stringify(body));
    return name;
  };

  it("MATCHes when every located value equals the declared artifactClass", () => {
    const a = artifact("m.json", { lanes: [{ verdict: "underpowered" }, { verdict: "underpowered" }] });
    const [c] = checkArtifacts(reg([row({ artifact: a, artifactClassLocator: "lanes[].verdict", artifactClass: "underpowered" })]), root);
    expect(c!.state).toBe("MATCH");
    expect(c!.detail).toContain("all 2 located");
  });

  it("flags DIVERGENT when the artifact agrees with artifactClass but not with the governing class", () => {
    // The real vendor-lane case: the artifact's own verdict field predates the
    // decision that governs, so the register declares both and the gap is visible.
    const a = artifact("d.json", { lane: { verdict: "insufficient_evidence" } });
    const [c] = checkArtifacts(reg([row({ artifact: a, artifactClassLocator: "lane.verdict", artifactClass: "insufficient_evidence", divergenceReason: "superseded" })]), root);
    expect(c!.state).toBe("DIVERGENT");
    expect(c!.detail).toContain("governing class is underpowered");
  });

  it("BREAKs on a missing file, a locator that matches nothing, or a wrong transcription", () => {
    expect(checkArtifacts(reg([row({ artifact: "nope.json" })]), root)[0]!.state).toBe("BROKEN");
    const empty = artifact("e.json", { lane: {} });
    expect(checkArtifacts(reg([row({ artifact: empty, artifactClassLocator: "lane.verdict", artifactClass: "underpowered" })]), root)[0]!.state).toBe("BROKEN");
    const wrong = artifact("w.json", { lane: { verdict: "falsified" } });
    const c = checkArtifacts(reg([row({ artifact: wrong, artifactClassLocator: "lane.verdict", artifactClass: "underpowered" })]), root)[0]!;
    expect(c.state).toBe("BROKEN");
    expect(c.detail).toContain("register declares artifactClass");
  });

  it("MAPPs a retired row whose artifact carries no class, and never says 'mapping' for a live one", () => {
    const a = artifact("n.json", { promotion: [] });
    const noClass = { artifact: a, artifactClassLocator: undefined, artifactClass: undefined, divergenceReason: "labels not classes" };
    expect(checkArtifacts(reg([row(noClass)]), root)[0]!.state).toBe("MAPPED");
    const live = checkArtifacts(reg([row({ ...noClass, state: "live", clock: "gating", class: undefined, classAt: undefined, classDoc: undefined } as never)]), root)[0]!;
    expect(live.state).toBe("PROVENANCE");
    expect(live.detail).toContain("no class to map");
  });
});

describe("supply and the two readings", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "digests-"));
  const digest = (date: string, days: number) => writeFileSync(path.join(dir, `validation-digest-${date}.json`), JSON.stringify({ date, pooled: { days } }));

  it("is not measurable from fewer than two digests — the staleness rule's whole point", () => {
    const one = mkdtempSync(path.join(tmpdir(), "one-"));
    writeFileSync(path.join(one, "validation-digest-2026-09-13.json"), JSON.stringify({ date: "2026-09-13", pooled: { days: 0 } }));
    expect(measureSupply(one)).toBeNull();
    expect(measureSupply(mkdtempSync(path.join(tmpdir(), "none-")))).toBeNull();
  });

  it("differences the last two digests into observation-days per week", () => {
    digest("2026-09-06", 100);
    digest("2026-09-13", 121);
    const s = measureSupply(dir, new Date("2026-09-14T00:00:00Z"))!;
    expect(s.perWeek).toBeCloseTo(21, 6);
    expect(s.from).toBe("2026-09-06");
    expect(s.to).toBe("2026-09-13");
    expect(s.stale).toBe(false);
    // 2026-10-05 is 3.1 weeks after the newest digest, so still fresh; 4 weeks after
    // 2026-09-13 is 2026-10-11, so only past that is it stale.
    expect(measureSupply(dir, new Date("2026-10-05T00:00:00Z"))!.stale).toBe(false);
    expect(measureSupply(dir, new Date("2026-10-15T00:00:00Z"))!.stale).toBe(true);
  });

  it("withholds Reading B rather than extrapolating, and dates it only from a measured supply", () => {
    expect(projectDate(0, 157, null, new Date("2026-09-19T00:00:00Z")).reason).toContain("no positive gain in pooled observation-days");
    const stale = { perWeek: 21, from: "a", to: "b", days: 21, stale: true };
    expect(projectDate(0, 157, stale, new Date("2026-09-19T00:00:00Z")).reason).toContain("not measured since");
    // 157 needed at 21/week ≈ 52 days.
    const d = projectDate(0, 157, { perWeek: 21, from: "a", to: "b", days: 21, stale: false }, new Date("2026-09-19T00:00:00Z"));
    expect(d.reason).toBeNull();
    expect(d.date).toBe("2026-11-10");
  });

  it("takes the project-level reading from the LAST GATING hypothesis and ignores an accruing-only one", () => {
    const mk = (id: string, gating: boolean, date: string | null): LiveReading =>
      ({ id, gating, observedDays: 0, daysNeeded: 1, progress: 0, projectedDate: date, withheldReason: null, basis: null, detail: "" });
    const p = projectLevel([mk("a", true, "2027-01-01"), mk("b", true, "2027-06-30"), mk("c", false, "2099-01-01")]);
    expect(p.date).toBe("2027-06-30"); // not the accruing-only 2099
    expect(p.liveGating).toBe(2);
    expect(p.complete).toBe(false);
    // One withheld gating row withholds the project-level date rather than silently
    // reporting the other one.
    expect(projectLevel([mk("a", true, "2027-01-01"), mk("b", true, null)]).date).toBe("2027-01-01");
    expect(projectLevel([mk("a", true, "2027-01-01"), mk("b", true, null)]).withheld).toEqual(["b"]);
    expect(projectLevel([mk("c", false, "2099-01-01")])).toMatchObject({ complete: true, date: null, liveGating: 0 });
  });
});

describe("rendering, and the checked-in register", () => {
  const report: NorthStarReport = {
    generatedAt: "2026-09-19T00:00:00.000Z",
    metricDoc: "docs/north-star-metric-lock.md",
    rows: [row({ id: "H1-vendor", class: "underpowered" })],
    artifacts: [{ id: "H1-vendor", state: "DIVERGENT", detail: "d" }],
    schemaErrors: [],
    readings: [],
    supply: null,
    project: { date: null, withheld: [], liveGating: 0, complete: true },
    classes: { underpowered: 1 },
    verdict: "OK",
  };

  it("states L2's condition, the class distribution, and the anti-Goodhart clause", () => {
    const text = renderNorthStar(report).join("\n");
    expect(text).toContain("L2 — It can decide: COMPLETE");
    expect(text).toContain("classes (retired): underpowered 1");
    expect(text).toContain("we are winning");
    expect(text).toContain("anti-Goodhart clause");
    expect(text).toContain("DIVERGENT");
  });

  it("parses its arguments and rejects an unknown one", () => {
    expect(parseNorthStarArgs([]).register).toBe(REGISTER_FILE);
    expect(parseNorthStarArgs(["--json"]).json).toBe(true);
    expect(() => parseNorthStarArgs(["--nope"])).toThrow(/unknown argument/);
  });

  it("the CHECKED-IN register is schema-valid and every pointer in it resolves", () => {
    // This is the block that keeps the register honest: L2's completion condition
    // reads this file, so a broken row must fail the suite, not the reading.
    const loaded = JSON.parse(require("node:fs").readFileSync(REGISTER_FILE, "utf8")) as HypothesisRegister;
    expect(validateRegister(loaded)).toEqual([]);
    const checks = checkArtifacts(loaded);
    const broken = checks.filter((c) => c.state === "BROKEN");
    expect(broken).toEqual([]);
    // The three retired hypotheses, and the one deliberate divergence.
    expect(loaded.hypotheses.filter((h) => h.state === "retired")).toHaveLength(3);
    expect(checks.filter((c) => c.state === "DIVERGENT").map((c) => c.id)).toEqual(["H1-vendor"]);
  });
});
