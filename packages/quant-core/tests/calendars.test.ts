import { describe, expect, it } from "vitest";
import { HKEX_ADHOC_CLOSURES, HKEX_HOLIDAYS, HKEX_KNOWN_NON_SESSIONS, NYSE_HOLIDAYS } from "../src/calendars.js";

const weekday = (d: string) => new Date(d + "T00:00:00Z").getUTCDay();
const byYear = (set: ReadonlySet<string>, year: number) =>
  [...set].filter((d) => d.startsWith(String(year)));

describe("exchange holiday calendars (static, refresh annually)", () => {
  it("contains known closure dates", () => {
    // Measured HKEX phantom-bar date (Lunar New Year eve 2022) — RULE L1.
    expect(HKEX_HOLIDAYS.has("2022-01-31")).toBe(true);
    // NYSE Independence Day 2022.
    expect(NYSE_HOLIDAYS.has("2022-07-04")).toBe(true);
    // 2022-12-26: Christmas observed in BOTH markets (Dec 25 fell Sunday).
    expect(HKEX_HOLIDAYS.has("2022-12-26")).toBe(true);
    expect(NYSE_HOLIDAYS.has("2022-12-26")).toBe(true);
  });

  it("ad-hoc closures: the measured tencent phantoms, disjoint from the published calendar", () => {
    // docs/phase-0-verification-report.md §G2b: HKEX was shut all day on each
    // of these, tencent serves bars, Yahoo does not.
    for (const d of ["2023-07-17", "2023-09-01", "2023-09-08"]) expect(HKEX_ADHOC_CLOSURES.has(d), d).toBe(true);
    for (const d of HKEX_ADHOC_CLOSURES) {
      expect(HKEX_HOLIDAYS.has(d), d).toBe(false); // ad-hoc, never published
      expect(weekday(d), d).toBeGreaterThanOrEqual(1);
      expect(weekday(d), d).toBeLessThanOrEqual(5);
    }
  });

  it("KNOWN_NON_SESSIONS is the union (the sentinel's attribution set)", () => {
    expect(HKEX_KNOWN_NON_SESSIONS.size).toBe(HKEX_HOLIDAYS.size + HKEX_ADHOC_CLOSURES.size);
    expect(HKEX_KNOWN_NON_SESSIONS.has("2022-01-31")).toBe(true); // published holiday
    expect(HKEX_KNOWN_NON_SESSIONS.has("2023-09-01")).toBe(true); // cyclone closure
  });

  it("every listed date is a weekday", () => {
    for (const d of [...HKEX_HOLIDAYS, ...NYSE_HOLIDAYS]) {
      expect(weekday(d), d).toBeGreaterThanOrEqual(1);
      expect(weekday(d), d).toBeLessThanOrEqual(5);
    }
  });

  it("sane per-year counts (HK 13–18, US 9–11) over 2021–2027", () => {
    for (let y = 2021; y <= 2027; y++) {
      const hk = byYear(HKEX_HOLIDAYS, y).length;
      const us = byYear(NYSE_HOLIDAYS, y).length;
      expect(hk, `HKEX ${y}`).toBeGreaterThanOrEqual(13);
      expect(hk, `HKEX ${y}`).toBeLessThanOrEqual(18);
      expect(us, `NYSE ${y}`).toBeGreaterThanOrEqual(9);
      expect(us, `NYSE ${y}`).toBeLessThanOrEqual(11);
    }
    // coverage window boundaries
    expect(byYear(HKEX_HOLIDAYS, 2020)).toHaveLength(0);
    expect(byYear(NYSE_HOLIDAYS, 2028)).toHaveLength(0);
  });
});
