/**
 * Pure-function tests for the close-persistence re-audit
 * (src/cli/audit-inband-persistence.ts). Key anchors: AACT 2023-07-27 and
 * AAMI 2025-01-24 are bad open prints (closes never leave the pre-split
 * level) and must classify 'bad-print'; ACRS 2023-11-13 and ACRX 2022-10-26
 * are genuine reverse splits whose close repriced then drifted and must
 * classify 'genuine-persistent'. Also: shallow factors (bands overlap) are
 * rescued by the impliedHits guard, and deep-reverse drift past tolerance
 * is still genuine. No db, no filesystem.
 */
import { describe, expect, it } from "vitest";
import { classifyPersistence, type PersistenceBar } from "../../src/cli/audit-inband-persistence.js";

const bar = (date: string, close: number, segmentId = "S#1"): PersistenceBar => ({ date, close, segmentId });

describe("classifyPersistence", () => {
  it("reproduces AACT 2023-07-27 as bad-print (open doubled, closes unmoved)", () => {
    // Vendor rows: prevClose 10.18; ex-day open 15.9 (factor 0.64) but closes stay ~10.2.
    const bars = [bar("2023-07-26", 10.18), bar("2023-07-27", 10.15), bar("2023-07-28", 10.2), bar("2023-07-31", 10.18), bar("2023-08-01", 10.22)];
    const v = classifyPersistence({ symbol: "AACT", exDate: "2023-07-27", factor: 0.64 }, bars);
    expect(v.cls).toBe("bad-print");
    expect(v.prevHits).toBe(4);
    expect(v.persistHits).toBe(0);
  });

  it("reproduces ACRS 2023-11-13 as genuine-persistent (repriced, then drifted)", () => {
    // prevClose 4.755, 1:5 reverse (factor 5, implied 0.951); closes 0.95, 0.82, 0.65, 0.70.
    const bars = [bar("2023-11-10", 4.755), bar("2023-11-13", 0.95), bar("2023-11-14", 0.82), bar("2023-11-15", 0.65), bar("2023-11-16", 0.7)];
    const v = classifyPersistence({ symbol: "ACRS", exDate: "2023-11-13", factor: 5 }, bars);
    expect(v.cls).toBe("genuine-persistent");
    expect(v.prevHits).toBe(0);
  });

  it("rescues shallow factors where the tolerance bands overlap (RELL 2025-04-10, factor 1.39)", () => {
    // prevClose 10; implied 7.19. Closes ~8.5 sit within 25% log of BOTH
    // levels — not a bad print, the ex-open matched the factor exactly.
    const bars = [bar("2025-04-09", 10), bar("2025-04-10", 8.5), bar("2025-04-11", 8.4), bar("2025-04-14", 8.6), bar("2025-04-15", 8.5)];
    const v = classifyPersistence({ symbol: "RELL", exDate: "2025-04-10", factor: 1.391304 }, bars);
    expect(v.cls).toBe("genuine-persistent");
    expect(v.prevHits).toBe(4); // overlap: near prevClose too
    expect(v.persistHits).toBe(4); // but also near implied — rescued
  });

  it("deep-reverse drift past tolerance is still genuine (AGRX 2022-04-27 style)", () => {
    // factor 0.03 (1:33): exClose matches implied, next sessions slide >25%.
    const bars = [bar("2022-04-26", 0.5), bar("2022-04-27", 15), bar("2022-04-28", 11), bar("2022-04-29", 9), bar("2022-05-02", 8)];
    const v = classifyPersistence({ symbol: "AGRX", exDate: "2022-04-27", factor: 0.03 }, bars);
    expect(v.cls).toBe("genuine-persistent");
  });

  it("single-day close excursion then revert is a bad print (LEV+A 2024-05-03 style)", () => {
    const bars = [bar("2024-05-01", 0.177), bar("2024-05-03", 0.3), bar("2024-05-08", 0.168), bar("2024-05-10", 0.144), bar("2024-05-13", 0.17)];
    const v = classifyPersistence({ symbol: "LEV+A", exDate: "2024-05-03", factor: 0.590909 }, bars);
    expect(v.cls).toBe("bad-print");
  });

  it("not-testable when ex/prev bars are missing or across a segment stitch", () => {
    expect(classifyPersistence({ symbol: "S", exDate: "2024-01-03", factor: 2 }, [bar("2024-01-02", 100)]).cls).toBe("not-testable");
    const stitched = [bar("2024-01-02", 100, "S#1"), bar("2024-02-01", 5, "S#2")];
    expect(classifyPersistence({ symbol: "S", exDate: "2024-02-01", factor: 20 }, stitched).cls).toBe("not-testable");
  });

  it("window never crosses into the next segment", () => {
    // ex-day close repriced (implied 50), next session is a new segment whose
    // closes sit at 100 — must not count as prevHits.
    const bars = [bar("2024-01-02", 100, "S#1"), bar("2024-01-03", 50, "S#1"), bar("2024-01-04", 100, "S#2"), bar("2024-01-05", 100, "S#2")];
    const v = classifyPersistence({ symbol: "S", exDate: "2024-01-03", factor: 2 }, bars);
    expect(v.persistTotal).toBe(1);
    expect(v.cls).toBe("genuine-persistent");
  });
});
