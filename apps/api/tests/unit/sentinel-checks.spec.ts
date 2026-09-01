/**
 * Unit tests for the four sentinel diff checks (phase-1-hardening-plan §B.3) —
 * fixture-driven, no I/O. Every ALARM rule is injected explicitly, and every
 * "clean" case includes the realistic nuisances (window-edge dates, float
 * noise, provider calendar phantoms) that must NOT alarm.
 */
import type { Bar } from "@agentic-trading/quant-core";
import { HKEX_ADHOC_CLOSURES, HKEX_KNOWN_NON_SESSIONS } from "@agentic-trading/quant-core";
import { describe, expect, it } from "vitest";
import {
  checkCaRevision,
  checkEastmoneyRaw,
  checkTencentDates,
  checkYahooRewrite,
  closeEquals,
  worstStatus,
} from "../../src/sentinel/sentinel-checks.js";

function bars(dates: string[], close: (d: string, i: number) => number = () => 100): Bar[] {
  return dates.map((date, i) => ({ date, open: null, high: null, low: null, volume: null, close: close(date, i) }));
}

/** Ascending weekday dates starting `from`, n of them. */
function weekdays(from: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** A published HKEX closure inside the 2026 fixture window (Lunar New Year
 *  day 2, a Wednesday) — used as the phantom-session date. */
const HOLIDAY = "2026-02-18";
/** A measured ad-hoc closure (Typhoon Talim) — tencent serves a bar, we do not
 *  (verification report §G2b); it must not alarm either. */
const ADHOC = "2023-07-17";
const holidays = HKEX_KNOWN_NON_SESSIONS;

describe("checkYahooRewrite — same-provider rewrite detector", () => {
  it("identical series ⇒ ok", () => {
    const dates = weekdays("2026-01-05", 20);
    expect(checkYahooRewrite(bars(dates), bars(dates))).toMatchObject({
      check: "yahoo-rewrite",
      status: "ok",
      metrics: { onlyStored: 0, onlyFresh: 0, closeMismatch: 0 },
    });
  });

  it("float noise below 1e-9 relative ⇒ ok (not a revision)", () => {
    const dates = weekdays("2026-01-05", 10);
    const stored = bars(dates);
    const fresh = dates.map((d) => ({ ...bars([d])[0]!, close: 100 * (1 + 1e-12) }));
    expect(checkYahooRewrite(stored, fresh).status).toBe("ok");
  });

  it("one revised close ⇒ ALARM with the date and deviation", () => {
    const dates = weekdays("2026-01-05", 20);
    const fresh = bars(dates);
    fresh[7] = { ...fresh[7]!, close: 101.5 };
    const r = checkYahooRewrite(bars(dates), fresh);
    expect(r.status).toBe("alarm");
    expect(r.metrics.closeMismatch).toBe(1);
    expect(r.summary).toContain("ALARM");
    expect(r.details.join(" ")).toContain(dates[7]!);
    expect(r.details.join(" ")).toMatch(/stored 100 → fresh 101\.5/);
  });

  it("close that becomes null ⇒ ALARM (value disappearing is a revision)", () => {
    const dates = weekdays("2026-01-05", 5);
    const fresh = bars(dates);
    fresh[2] = { ...fresh[2]!, close: null };
    const r = checkYahooRewrite(bars(dates), fresh);
    expect(r.status).toBe("alarm");
    expect(r.details.join(" ")).toContain("stored 100 → fresh null");
  });

  it("date dropped from the fresh window ⇒ ALARM", () => {
    const dates = weekdays("2026-01-05", 12);
    const r = checkYahooRewrite(bars(dates), bars(dates.filter((d) => d !== dates[5])));
    expect(r.status).toBe("alarm");
    expect(r.metrics.onlyFresh).toBe(0);
    expect(r.metrics.onlyStored).toBe(1);
    expect(r.details.join(" ")).toContain("in store but Yahoo no longer serves");
  });

  it("date added to the fresh window ⇒ ALARM", () => {
    const dates = weekdays("2026-01-05", 12);
    const extra = "2026-01-10"; // a Saturday: a bar Yahoo fabricated where no session existed
    const fresh = [...dates, extra].sort();
    const r = checkYahooRewrite(bars(dates), bars(fresh));
    expect(r.status).toBe("alarm");
    expect(r.metrics.onlyFresh).toBe(1);
    expect(r.details.join(" ")).toContain("Yahoo serves but not stored");
  });

  it("window-edge dates outside the overlap are never mismatches", () => {
    // Store written 4 weeks ago: 24 dates. Fresh trailing window starts later
    // and ends later: the store's oldest dates and the fresh's newest dates
    // are outside the overlap and must not alarm.
    const stored = weekdays("2026-01-05", 24);
    const fresh = stored.slice(4, 24).concat(weekdays("2026-02-17", 4));
    const r = checkYahooRewrite(bars(stored), bars([...fresh].sort()));
    expect(r.status).toBe("ok");
    expect(r.metrics.windowDays).toBe(20);
  });

  it("store owned by another source ⇒ skip (single-source invariant)", () => {
    const dates = weekdays("2026-01-05", 5);
    const r = checkYahooRewrite(bars(dates), bars(dates), "eastmoney");
    expect(r.status).toBe("skip");
    expect(r.summary).toContain("store=eastmoney");
  });

  it("no fresh fetch ⇒ skip", () => {
    const dates = weekdays("2026-01-05", 5);
    expect(checkYahooRewrite(bars(dates), []).status).toBe("skip");
  });

  it("disjoint windows ⇒ ALARM (no overlap to compare at all)", () => {
    const r = checkYahooRewrite(bars(weekdays("2020-01-06", 5)), bars(weekdays("2026-01-05", 5)));
    expect(r.status).toBe("alarm");
    expect(r.summary).toContain("no-overlap");
  });

  it("mismatch list is capped but the count is exact", () => {
    const dates = weekdays("2026-01-05", 30);
    const fresh = dates.map((d, i) => ({ ...bars([d])[0]!, close: i < 12 ? 90 : 100 }));
    const r = checkYahooRewrite(bars(dates), fresh);
    expect(r.metrics.closeMismatch).toBe(12);
    expect(r.details.filter((d) => /^\d{4}-\d{2}-\d{2}: stored/.test(d))).toHaveLength(8);
    expect(r.details.join(" ")).toContain("and 4 more mismatching closes");
  });
});

describe("checkEastmoneyRaw — cross-source raw closes", () => {
  it("identical closes ⇒ ok, 0% deviation", () => {
    const dates = weekdays("2026-01-05", 60);
    const r = checkEastmoneyRaw(bars(dates), bars(dates));
    expect(r.status).toBe("ok");
    expect(r.metrics).toMatchObject({ commonDates: 60, maxAbsDevPct: 0, meanAbsDevPct: 0 });
  });

  it("max |dev| > 1% ⇒ ALARM naming the date", () => {
    const dates = weekdays("2026-01-05", 60);
    const raw = bars(dates);
    raw[40] = { ...raw[40]!, close: 101.5 }; // +1.5%
    const r = checkEastmoneyRaw(bars(dates), raw);
    expect(r.status).toBe("alarm");
    expect(r.metrics.maxAbsDevPct).toBeCloseTo(1.5, 4);
    expect(r.metrics.maxDevDate).toBe(dates[40]);
    expect(r.details.join(" ")).toContain("max |dev|");
  });

  it("mean |dev| above the 0.27% noise floor (max below 1%) ⇒ WARN", () => {
    const dates = weekdays("2026-01-05", 60);
    const raw = bars(dates, () => 100.5); // +0.5% everywhere, max 0.5% < 1%
    const r = checkEastmoneyRaw(bars(dates), raw);
    expect(r.status).toBe("warn");
    expect(r.metrics.maxAbsDevPct).toBeCloseTo(0.5, 4);
    expect(r.summary).toContain("WARN");
  });

  it("in-window date mismatch ⇒ ALARM even when closes agree", () => {
    const dates = weekdays("2026-01-05", 60);
    const raw = bars(dates.filter((d) => d !== dates[30]));
    const r = checkEastmoneyRaw(bars(dates), raw);
    expect(r.status).toBe("alarm");
    expect(r.metrics.onlyEastmoney).toBe(0);
    expect(r.metrics.onlyStored).toBe(1);
  });

  it("eastmoney's longer history beyond the store is a window edge, not a mismatch", () => {
    const stored = weekdays("2026-01-05", 60);
    const raw = weekdays("2025-12-01", 12).concat(stored);
    const r = checkEastmoneyRaw(bars(stored), bars(raw));
    expect(r.status).toBe("ok");
    expect(r.metrics.commonDates).toBe(60);
  });

  it("thin overlap (<50 common dates) ⇒ WARN", () => {
    const dates = weekdays("2026-01-05", 10);
    const r = checkEastmoneyRaw(bars(dates), bars(dates));
    expect(r.status).toBe("warn");
    expect(r.details.join(" ")).toContain("thin overlap");
  });

  it("nothing comparable (null closes) ⇒ ALARM", () => {
    const dates = weekdays("2026-01-05", 60);
    const r = checkEastmoneyRaw(bars(dates), bars(dates).map((b) => ({ ...b, close: null })));
    expect(r.status).toBe("alarm");
    expect(r.details.join(" ")).toContain("no comparable common dates");
  });

  it("disjoint windows ⇒ ALARM", () => {
    expect(checkEastmoneyRaw(bars(weekdays("2020-01-06", 5)), bars(weekdays("2026-01-05", 5))).status).toBe("alarm");
  });
});

describe("checkTencentDates — session calendar only, never closes", () => {
  it("tencent's 1200-bar truncation at the window edge ⇒ ok", () => {
    const reference = weekdays("2026-01-05", 60);
    const tencent = reference.slice(10); // older sessions beyond tencent's cap
    const r = checkTencentDates(reference, tencent, holidays);
    expect(r.status).toBe("ok");
    expect(r.metrics.overlapDays).toBe(50);
    expect(r.metrics.overlapPct).toBe(100);
  });

  it("tencent phantom on a known HKEX closure ⇒ ok + note (their bug, our data is right)", () => {
    const reference = weekdays("2026-01-05", 40).filter((d) => d !== HOLIDAY); // exchange shut: no session
    const tencent = [...reference, HOLIDAY].sort();
    const r = checkTencentDates(reference, tencent, holidays);
    expect(r.status).toBe("ok");
    expect(r.metrics).toMatchObject({ onlyTencent: 0, tencentPhantomClosures: 1, ourPhantomSessions: 0 });
    expect(r.details.join(" ")).toContain("provider calendar bug, not a revision");
    expect(r.summary).toContain("+1 tencent phantom");
  });

  it("our-series phantom on a known HKEX closure ⇒ WARN too (Yahoo side)", () => {
    const reference = weekdays("2026-01-05", 40); // includes the 2026-02-18 closure
    const r = checkTencentDates(reference, reference.filter((d) => d !== HOLIDAY), holidays);
    expect(r.status).toBe("warn");
    expect(r.metrics).toMatchObject({ onlyReference: 0, ourPhantomSessions: 1, tencentPhantomClosures: 0 });
    expect(r.details.join(" ")).toContain("check the daily run");
  });

  it("ad-hoc cyclone closure (measured tencent phantom) ⇒ WARN, not ALARM", () => {
    // The live sentinel run of 2026-09-02 hit exactly these three dates on 9 of
    // the 10 sample names — classified as tencent calendar bugs in the
    // verification report, so the ad-hoc closure set carries them out of ALARM.
    const reference = weekdays("2023-07-10", 8).filter((d) => d !== ADHOC);
    const tencent = [...reference, ADHOC].sort();
    expect(reference).not.toContain(ADHOC);
    const r = checkTencentDates(reference, tencent);
    expect(r.status).toBe("ok");
    expect(r.metrics).toMatchObject({ onlyTencent: 0, tencentPhantomClosures: 1 });
    expect(HKEX_ADHOC_CLOSURES.has(ADHOC)).toBe(true);
  });

  it("tencent-only date on a real session ⇒ ALARM", () => {
    const reference = weekdays("2026-01-05", 40);
    const tencent = [...reference, "2026-02-14"].sort(); // a Saturday, not a holiday
    const r = checkTencentDates(reference, tencent, holidays);
    expect(r.status).toBe("alarm");
    expect(r.metrics.onlyTencent).toBe(1);
    expect(r.details.join(" ")).toContain("in tencent but absent from our series");
  });

  it("session missing from tencent inside the window ⇒ ALARM", () => {
    const reference = weekdays("2026-01-05", 40);
    const r = checkTencentDates(reference, reference.filter((d) => d !== reference[20]), holidays);
    expect(r.status).toBe("alarm");
    expect(r.metrics.onlyReference).toBe(1);
    expect(r.summary).toContain("ALARM");
  });

  it("disjoint windows ⇒ ALARM", () => {
    expect(checkTencentDates(weekdays("2020-01-06", 5), weekdays("2026-01-05", 5), holidays).status).toBe("alarm");
  });

  it("defaults to HKEX_KNOWN_NON_SESSIONS when no set is passed", () => {
    const reference = weekdays("2026-01-05", 40).filter((d) => d !== HOLIDAY);
    // tencent-side phantom ⇒ ok with a note, and the default set covers the
    // ad-hoc closures too.
    expect(checkTencentDates(reference, [...reference, HOLIDAY].sort()).status).toBe("ok");
    expect(checkTencentDates([ADHOC], [ADHOC], undefined).metrics).toMatchObject({ overlapDays: 1 });
  });
});

describe("checkCaRevision — dividend event delta is WARN-only", () => {
  const events = (dates: string[]): { date: string; amount: number }[] => dates.map((date) => ({ date, amount: 1 }));

  it("identical ⇒ ok", () => {
    const e = events(["2026-03-05", "2026-06-11"]);
    expect(checkCaRevision(e, e).status).toBe("ok");
  });

  it("new event appears upstream ⇒ WARN with the re-run hint", () => {
    const stored = events(["2026-03-05"]);
    const fresh = events(["2026-03-05", "2026-06-11"]);
    const r = checkCaRevision(stored, fresh);
    expect(r.status).toBe("warn");
    expect(r.metrics.onlyFresh).toBe(1);
    expect(r.details.join(" ")).toContain("re-run screen:daily");
  });

  it("stored event vanished upstream ⇒ WARN", () => {
    const r = checkCaRevision(events(["2026-03-05", "2026-06-11"]), events(["2026-03-05"]));
    expect(r.status).toBe("warn");
    expect(r.metrics.onlyStored).toBe(1);
  });

  it("amount restated ⇒ WARN listing the date", () => {
    const r = checkCaRevision([{ date: "2026-03-05", amount: 1 }], [{ date: "2026-03-05", amount: 1.05 }]);
    expect(r.status).toBe("warn");
    expect(r.details.join(" ")).toContain("stored amount 1 → fresh 1.05");
  });

  it("an explicit bar-level window excludes edge events", () => {
    const stored = events(["2025-09-05", "2026-03-05"]);
    const fresh = events(["2026-03-05"]);
    expect(checkCaRevision(stored, fresh, { from: "2026-01-01", to: "2026-12-31" }).status).toBe("ok");
    // Without the window every event is compared, so the pre-window stored
    // event shows up as vanished (the CLI always passes the bar window).
    const noWindow = checkCaRevision(stored, fresh);
    expect(noWindow.status).toBe("warn");
    expect(noWindow.metrics.onlyStored).toBe(1);
  });

  it("CA_DEGRADED name: restated amounts are recorded but do not warn", () => {
    const r = checkCaRevision([{ date: "2026-03-05", amount: 0.78407 }], [{ date: "2026-03-05", amount: 0.78402 }], undefined, {
      ignoreAmounts: true,
    });
    expect(r.status).toBe("ok");
    expect(r.metrics).toMatchObject({ amountMismatch: 0, restatedAmounts: 1, amountsIgnored: 1 });
    expect(r.summary).toContain("ok 1 events (+1 restated)");
    expect(r.details.join(" ")).toContain("change every fetch");
  });

  it("CA_DEGRADED name: a vanished/appeared event still warns", () => {
    const r = checkCaRevision(
      [{ date: "2026-03-05", amount: 1 }],
      [{ date: "2026-03-05", amount: 9 }, { date: "2026-07-02", amount: 1 }],
      undefined,
      { ignoreAmounts: true },
    );
    expect(r.status).toBe("warn");
    expect(r.metrics.onlyFresh).toBe(1);
  });

  it("both empty ⇒ ok", () => {
    expect(checkCaRevision([], [])).toMatchObject({ status: "ok", summary: "ok 0 events" });
  });
});

describe("helpers", () => {
  it("closeEquals treats null symmetrically and ignores sub-epsilon noise", () => {
    expect(closeEquals(null, null)).toBe(true);
    expect(closeEquals(1, null)).toBe(false);
    expect(closeEquals(null, 1)).toBe(false);
    expect(closeEquals(100, 100 + 1e-9)).toBe(true);
    expect(closeEquals(100, 100.01)).toBe(false);
    expect(closeEquals(0.5, 0.5000000001)).toBe(true);
  });

  it("worstStatus ranks alarm > warn > ok > skip", () => {
    expect(worstStatus(["ok", "skip"])).toBe("ok");
    expect(worstStatus(["skip", "skip"])).toBe("skip");
    expect(worstStatus(["ok", "warn"])).toBe("warn");
    expect(worstStatus(["warn", "alarm"])).toBe("alarm");
    expect(worstStatus([])).toBe("skip");
  });
});
