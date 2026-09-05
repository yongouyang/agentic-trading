/**
 * Pure-function tests for the repair-store-bars sanity gate
 * (src/cli/repair-store-bars.ts): a fresh fetch that still contains the
 * pathology being repaired (phantom half-price bars ⇒ ~2× overnight jump)
 * must fail the gate so the CLI aborts WITHOUT touching the store; a
 * smooth series with all required dates present passes. No db, no network.
 */
import { describe, expect, it } from "vitest";
import { checkFetchedSeries } from "../../src/cli/repair-store-bars.js";

const bar = (date: string, price: number) => ({ date, open: price, high: price, low: price, close: price, volume: 1000 });

describe("checkFetchedSeries", () => {
  it("passes a smooth series with required dates present", () => {
    const bars = [bar("2026-08-06", 47), bar("2026-08-07", 46), bar("2026-08-10", 45.5)];
    expect(checkFetchedSeries(bars, { requiredDates: ["2026-08-10"] }).ok).toBe(true);
  });

  it("fails on a phantom-bar-scale overnight jump (MNST 07-17→07-20 pattern)", () => {
    // 97.5 close → 48.6 open = 0.499× — the phantom half-price signature.
    const bars = [bar("2026-07-17", 97.5), bar("2026-07-20", 48.6)];
    const check = checkFetchedSeries(bars);
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatch(/overnight jump/);
  });

  it("fails when a required date is missing or null-close", () => {
    const bars = [bar("2026-08-07", 46), { date: "2026-08-10", open: null, high: null, low: null, close: null, volume: null }];
    const check = checkFetchedSeries(bars, { requiredDates: ["2026-08-10"] });
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatch(/2026-08-10/);
  });

  it("ignores null bars when evaluating jumps", () => {
    const bars = [bar("2026-08-07", 46), { date: "2026-08-08", open: null, high: null, low: null, close: null, volume: null }, bar("2026-08-10", 45.5)];
    expect(checkFetchedSeries(bars).ok).toBe(true);
  });
});
