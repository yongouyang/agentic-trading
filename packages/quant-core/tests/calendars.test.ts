import { describe, expect, it } from "vitest";
import {
  HKEX_ADHOC_CLOSURES,
  HKEX_HOLIDAYS,
  HKEX_KNOWN_NON_SESSIONS,
  NYSE_HOLIDAYS,
  SESSION_CLOSE,
  sessionClosed,
} from "../src/calendars.js";

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

describe("sessionClosed — a bar enters the store only after its session's official close", () => {
  // 2026-07-15 is EDT (UTC-4): 16:00 ET = 20:00Z.
  it("US summer (EDT): 15:59 ET is still open, 16:01 ET is closed", () => {
    expect(sessionClosed("US", "2026-07-15", new Date("2026-07-15T19:59:00Z"))).toBe(false);
    expect(sessionClosed("US", "2026-07-15", new Date("2026-07-15T20:01:00Z"))).toBe(true);
  });

  // 2026-01-15 is EST (UTC-5): 16:00 ET = 21:00Z — one UTC hour later than EDT.
  // This is the case a hardcoded offset gets wrong half the year.
  it("US winter (EST): the boundary moves one UTC hour, and the filter follows", () => {
    expect(sessionClosed("US", "2026-01-15", new Date("2026-01-15T20:30:00Z"))).toBe(false); // 15:30 EST
    expect(sessionClosed("US", "2026-01-15", new Date("2026-01-15T21:01:00Z"))).toBe(true); // 16:01 EST
  });

  it("exactly at the close instant is NOT closed (strictly after)", () => {
    expect(sessionClosed("US", "2026-07-15", new Date("2026-07-15T20:00:00Z"))).toBe(false);
  });

  // HK: 16:10 HKT = 08:10Z, no DST.
  it("HK: 16:09 HKT is still open, 16:11 HKT is closed", () => {
    expect(sessionClosed("HK", "2026-09-11", new Date("2026-09-11T08:09:00Z"))).toBe(false);
    expect(sessionClosed("HK", "2026-09-11", new Date("2026-09-11T08:11:00Z"))).toBe(true);
  });

  it("a bar dated a past session always passes", () => {
    // Now = mid-morning of the NEXT US session: yesterday's bar is long closed.
    expect(sessionClosed("US", "2026-07-14", new Date("2026-07-15T13:00:00Z"))).toBe(true);
    expect(sessionClosed("HK", "2026-09-10", new Date("2026-09-11T02:00:00Z"))).toBe(true);
  });

  it("23:03 HKT during the US session: the forming US bar is filtered, the completed HK one passes", () => {
    // The late catch-up slot (2026-09-13 decision). 23:03 HKT = 15:03Z; in EDT
    // the US session of 2026-09-11 opened 21:30 HKT and is mid-session.
    const now = new Date("2026-09-11T15:03:00Z"); // 23:03 HKT, 11:03 EDT
    expect(sessionClosed("US", "2026-09-11", now)).toBe(false); // forming bar
    expect(sessionClosed("US", "2026-09-10", now)).toBe(true); // last completed session
    expect(sessionClosed("HK", "2026-09-11", now)).toBe(true); // HK closed 16:10 HKT
  });

  it("exposes the close-time table it is driven by", () => {
    expect(SESSION_CLOSE.US).toEqual({ timeZone: "America/New_York", closeLocal: "16:00" });
    expect(SESSION_CLOSE.HK).toEqual({ timeZone: "Asia/Hong_Kong", closeLocal: "16:10" });
  });
});
