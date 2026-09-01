/**
 * Weekly sentinel diff checks (phase-1-hardening-plan §B) — pure functions,
 * no I/O, so every alarm rule is fixture-testable. The sentinel's job is the
 * one failure a single-provider posture cannot see: the provider **silently
 * rewriting history** between runs (architecture §4.3). Each check therefore
 * returns a status plus the numbers behind it (the JSON artifact is the
 * baseline for future diffs).
 *
 * Status ladder (row verdict = worst non-skip status):
 *   alarm > warn > ok > skip
 *
 * Four checks per name:
 *   1. `yahoo-rewrite`  same-provider rewrite detector: fresh full-window
 *      Yahoo fetch vs the stored series, on the overlapping date set. ANY
 *      mismatch ⇒ ALARM (there is no benign reason for Yahoo's own raw closes
 *      to change under us).
 *   2. `eastmoney-raw`  cross-source raw closes (the only source with raw HK
 *      bars). ALARM if max |dev| > 1% or an in-window date mismatch; WARN if
 *      mean |dev| > 0.27% — the measured Yahoo-vs-eastmoney baseline for
 *      0005.HK (verification report A2), i.e. the noise floor.
 *   3. `tencent-dates`  cross-source session calendar. Dates only — closes are
 *      never even fetched (RULE R4, tencent has no raw series). Any in-window
 *      mismatch ⇒ ALARM, EXCEPT dates HKEX was demonstrably shut (published
 *      holidays plus measured ad-hoc cyclone closures, i.e.
 *      `HKEX_KNOWN_NON_SESSIONS`): a bar on such a date is the CARRIER's
 *      calendar bug, not a revision (measured: tencent's typhoon-day phantoms
 *      2023-07-17/09-01/09-08, Yahoo's holiday phantoms RULE L1). Those are
 *      attributed by direction — tencent carries it ⇒ recorded as a note (our
 *      series is right), our series carries it ⇒ WARN (store contamination).
 *      An UNCLASSIFIED date mismatch is what alarms; a new cyclone closure
 *      alarms once, a human classifies it, and only then does
 *      HKEX_ADHOC_CLOSURES grow.
 *   4. `ca-revision`    stored vs fresh dividend events on the overlap window.
 *      Count/date delta ⇒ WARN, never ALARM (cross-source and window-edge CA
 *      differences are legitimate; the plan pinned this). RESTATED AMOUNTS are
 *      warned too — except on a CA_DEGRADED name, where the live sentinel run
 *      of 2026-09-02 proved the restatement is noise: Yahoo re-converts
 *      USD-declared HK dividends at a fresh FX rate on every fetch (0005.HK
 *      2026-08-13 came back 0.78407 → 0.78404003 → 0.78402 on three
 *      consecutive requests), so amounts are unusable by policy and a
 *      permanent weekly WARN would be self-inflicted noise. Date sets are
 *      still compared on those names.
 *
 * Window-edge rule shared by all checks: the store and each fresh fetch cover
 * slightly different 5-year windows (the store was written on an earlier date)
 * and tencent caps at 1200 bars. Dates outside the **overlap** of the two date
 * sets are never a mismatch — only in-window differences are.
 */
import { HKEX_KNOWN_NON_SESSIONS, type Bar } from "@agentic-trading/quant-core";

export type SentinelStatus = "alarm" | "warn" | "ok" | "skip";

export type SentinelCheckName = "yahoo-rewrite" | "eastmoney-raw" | "tencent-dates" | "ca-revision";

export interface SentinelCheck {
  check: SentinelCheckName;
  status: SentinelStatus;
  /** One-line cell for the stdout table. */
  summary: string;
  /** Numbers behind the verdict — the comparable part of the JSON artifact. */
  metrics: Record<string, number | string>;
  /** Loud, human-readable evidence (capped examples + full counts). */
  details: string[];
}

/** Relative float tolerance for "identical" closes — Yahoo raw closes are
 *  stable decimals, so anything above noise is a revision. */
export const CLOSE_REL_EPSILON = 1e-9;
/** ALARM threshold on max |dev|, in percent (phase-1-hardening-plan §B.2). */
export const EASTMONEY_ALARM_MAX_DEV_PCT = 1.0;
/** WARN threshold on mean |dev|, in percent — measured A2 noise floor. */
export const EASTMONEY_WARN_MEAN_DEV_PCT = 0.27;
/** Below this many common dates a cross-source comparison is meaningless. */
export const MIN_COMMON_DATES = 50;
/** How many mismatching dates to print before summarising. */
export const MAX_EXAMPLES = 8;

const STATUS_RANK: Record<SentinelStatus, number> = { alarm: 3, warn: 2, ok: 1, skip: 0 };

/** Worst of the non-skip statuses; "skip" when every input skipped. */
export function worstStatus(statuses: SentinelStatus[]): SentinelStatus {
  let worst: SentinelStatus = "skip";
  for (const s of statuses) if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  return worst;
}

/** Relative-equality on closes; null==null, null!=number (a value appearing
 *  or disappearing IS a revision). */
export function closeEquals(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= CLOSE_REL_EPSILON * scale;
}

export interface SentinelWindow {
  from: string;
  to: string;
}

/** Overlap of two ascending date sets, or null when they don't intersect. */
export function overlapWindow(a: string[], b: string[]): SentinelWindow | null {
  if (!a.length || !b.length) return null;
  const from = a[0]! > b[0]! ? a[0]! : b[0]!;
  const to = a[a.length - 1]! < b[b.length - 1]! ? a[a.length - 1]! : b[b.length - 1]!;
  return from <= to ? { from, to } : null;
}

function datesOf(bars: Bar[]): string[] {
  return bars.map((b) => b.date).sort();
}

function sliceInWindow<T extends { date: string }>(rows: T[], w: SentinelWindow): T[] {
  return rows.filter((r) => r.date >= w.from && r.date <= w.to);
}

function listed(dates: string[]): string {
  return dates.slice(0, MAX_EXAMPLES).join(",") + (dates.length > MAX_EXAMPLES ? ` (+${dates.length - MAX_EXAMPLES} more)` : "");
}

/** Check 1 — Yahoo fresh fetch vs the stored series (same-provider rewrite). */
export function checkYahooRewrite(stored: Bar[], fresh: Bar[], storedSource = "yahoo"): SentinelCheck {
  if (storedSource !== "yahoo") {
    // Single-source invariant (§A.2): a stored eastmoney series vs a Yahoo
    // fetch is a cross-source comparison, not a rewrite detector — the
    // cross-source thresholds live in checkEastmoneyRaw.
    return {
      check: "yahoo-rewrite",
      status: "skip",
      summary: `skip store=${storedSource}`,
      metrics: { storedSource },
      details: [`stored series owned by "${storedSource}" — same-provider rewrite check not applicable`],
    };
  }
  if (!fresh.length) {
    return { check: "yahoo-rewrite", status: "skip", summary: "skip no-fetch", metrics: {}, details: ["no fresh Yahoo fetch to compare"] };
  }
  const storedDates = datesOf(stored);
  const freshDates = datesOf(fresh);
  const w = overlapWindow(storedDates, freshDates);
  if (!w) {
    return {
      check: "yahoo-rewrite",
      status: "alarm",
      summary: "ALARM no-overlap",
      metrics: { storedBars: stored.length, freshBars: fresh.length },
      details: [`stored window ${storedDates[0]}…${storedDates[storedDates.length - 1]} does not overlap fresh ${freshDates[0]}…${freshDates[freshDates.length - 1]}`],
    };
  }
  const sRows = sliceInWindow(stored, w);
  const fRows = sliceInWindow(fresh, w);
  const sDates = sRows.map((b) => b.date);
  const fDates = fRows.map((b) => b.date);
  const sSet = new Set(sDates);
  const fSet = new Set(fDates);
  const onlyStored = sDates.filter((d) => !fSet.has(d));
  const onlyFresh = fDates.filter((d) => !sSet.has(d));
  const byDate = new Map(fRows.map((b) => [b.date, b]));
  const mismatch = sRows.filter((b) => {
    const f = byDate.get(b.date);
    return f !== undefined && !closeEquals(b.close, f.close);
  });

  const metrics: Record<string, number> = {
    windowDays: sSet.size + fSet.size - new Set([...sDates, ...fDates]).size,
    onlyStored: onlyStored.length,
    onlyFresh: onlyFresh.length,
    closeMismatch: mismatch.length,
  };
  const details: string[] = [];
  if (onlyStored.length) details.push(`in store but Yahoo no longer serves: ${listed(onlyStored)}`);
  if (onlyFresh.length) details.push(`Yahoo serves but not stored: ${listed(onlyFresh)}`);
  if (mismatch.length) {
    for (const b of mismatch.slice(0, MAX_EXAMPLES)) {
      const f = byDate.get(b.date)!;
      const dev = b.close && f.close != null ? ((f.close - b.close) / b.close) * 100 : NaN;
      details.push(`${b.date}: stored ${b.close ?? "null"} → fresh ${f.close ?? "null"} (${Number.isNaN(dev) ? "n/a" : `${dev >= 0 ? "+" : ""}${dev.toFixed(4)}%`})`);
    }
    if (mismatch.length > MAX_EXAMPLES) details.push(`… and ${mismatch.length - MAX_EXAMPLES} more mismatching closes`);
  }
  const dirty = onlyStored.length + onlyFresh.length + mismatch.length;
  return {
    check: "yahoo-rewrite",
    status: dirty ? "alarm" : "ok",
    summary: dirty ? `ALARM ${dirty}/${metrics.windowDays} differ` : `ok ${metrics.windowDays}d identical`,
    metrics,
    details,
  };
}

/** Check 2 — eastmoney raw closes vs the stored raw series (cross-source). */
export function checkEastmoneyRaw(stored: Bar[], raw: Bar[]): SentinelCheck {
  const storedDates = datesOf(stored);
  const rawDates = datesOf(raw);
  const w = overlapWindow(storedDates, rawDates);
  if (!w) {
    return {
      check: "eastmoney-raw",
      status: "alarm",
      summary: "ALARM no-overlap",
      metrics: { storedBars: stored.length, rawBars: raw.length },
      details: [`eastmoney window ${rawDates[0]}…${rawDates[rawDates.length - 1]} does not overlap the store`],
    };
  }
  const sRows = sliceInWindow(stored, w);
  const rRows = sliceInWindow(raw, w);
  const sSet = new Set(sRows.map((b) => b.date));
  const rSet = new Set(rRows.map((b) => b.date));
  const onlyStored = sRows.map((b) => b.date).filter((d) => !rSet.has(d));
  const onlyRaw = rRows.map((b) => b.date).filter((d) => !sSet.has(d));
  const byDate = new Map(rRows.map((b) => [b.date, b]));

  const devs: { date: string; pct: number }[] = [];
  for (const b of sRows) {
    const r = byDate.get(b.date);
    if (!r || b.close == null || r.close == null || b.close <= 0 || r.close <= 0) continue;
    devs.push({ date: b.date, pct: (r.close / b.close - 1) * 100 });
  }
  const abs = devs.map((d) => Math.abs(d.pct));
  const mean = abs.length ? abs.reduce((s, x) => s + x, 0) / abs.length : 0;
  const max = abs.length ? Math.max(...abs) : 0;
  const worst = devs.find((d) => Math.abs(d.pct) === max);
  const dateMismatch = onlyStored.length + onlyRaw.length;

  const metrics: Record<string, number | string> = {
    commonDates: devs.length,
    overlapPct: +(rSet.size ? ((devs.length / rSet.size) * 100).toFixed(2) : 0),
    meanAbsDevPct: +mean.toFixed(4),
    maxAbsDevPct: +max.toFixed(4),
    maxDevDate: worst?.date ?? "—",
    onlyStored: onlyStored.length,
    onlyEastmoney: onlyRaw.length,
  };
  const details: string[] = [];
  if (onlyStored.length) details.push(`stored sessions eastmoney lacks: ${listed(onlyStored)}`);
  if (onlyRaw.length) details.push(`eastmoney sessions not in store: ${listed(onlyRaw)}`);
  if (worst && max > 0) details.push(`max |dev| ${max.toFixed(4)}% on ${worst.date} (stored ${metrics.commonDates} common days, mean ${mean.toFixed(4)}%)`);

  let status: SentinelStatus = "ok";
  let flag = "";
  if (devs.length === 0) {
    status = "alarm";
    flag = "ALARM ";
    details.push("no comparable common dates with a positive close on both sides");
  } else if (max > EASTMONEY_ALARM_MAX_DEV_PCT || dateMismatch) {
    status = "alarm";
    flag = "ALARM ";
  } else if (mean > EASTMONEY_WARN_MEAN_DEV_PCT) {
    status = "warn";
    flag = "WARN ";
  } else if (devs.length < MIN_COMMON_DATES) {
    status = "warn";
    flag = "WARN ";
    details.push(`thin overlap: ${devs.length} common dates (< ${MIN_COMMON_DATES})`);
  }
  return {
    check: "eastmoney-raw",
    status,
    summary: `${flag}max ${max.toFixed(2)}% mean ${mean.toFixed(2)}% n${devs.length}`,
    metrics,
    details,
  };
}

/** Check 3 — tencent session dates vs the reference calendar. Closes are NOT
 *  compared (this function cannot see them: its inputs are date arrays). */
export function checkTencentDates(
  referenceDates: string[],
  tencentDates: string[],
  nonSessions: ReadonlySet<string> = HKEX_KNOWN_NON_SESSIONS,
): SentinelCheck {
  const y = [...referenceDates].sort();
  const t = [...tencentDates].sort();
  const w = overlapWindow(y, t);
  if (!w) {
    return {
      check: "tencent-dates",
      status: "alarm",
      summary: "ALARM no-overlap",
      metrics: { reference: y.length, tencent: t.length },
      details: [`tencent window ${t[0]}…${t[t.length - 1]} does not overlap the reference calendar ${y[0]}…${y[y.length - 1]}`],
    };
  }
  const inWindow = (dates: string[]) => dates.filter((d) => d >= w.from && d <= w.to);
  const yw = inWindow(y);
  const tw = inWindow(t);
  const ySet = new Set(yw);
  const tSet = new Set(tw);
  const onlyReference = yw.filter((d) => !tSet.has(d));
  const onlyTencent = tw.filter((d) => !ySet.has(d));
  // A bar on a date HKEX was demonstrably shut (published holiday or measured
  // ad-hoc closure) is the CARRIER's calendar bug, not a revision — so the two
  // directions are attributed separately:
  //   tencent carries it, we don't  → note (measured: tencent's typhoon days).
  //     Our series is right; warning weekly about a third-party bug we cannot
  //     fix would train everyone to ignore the sentinel.
  //   our series carries it, tencent doesn't → WARN: our store is contaminated
  //     (a Yahoo phantom that RULE L1 did not drop, e.g. volume > 0) and the
  //     daily run should be looked at.
  const tencentPhantoms = onlyTencent.filter((d) => nonSessions.has(d));
  const ourPhantomSessions = onlyReference.filter((d) => nonSessions.has(d));
  const tencentHoles = onlyTencent.filter((d) => !nonSessions.has(d));
  const referenceHoles = onlyReference.filter((d) => !nonSessions.has(d));
  const common = tw.filter((d) => ySet.has(d)).length;

  const metrics: Record<string, number | string> = {
    window: `${w.from}…${w.to}`,
    overlapDays: common,
    overlapPct: tw.length ? +((common / tw.length) * 100).toFixed(2) : 0,
    onlyReference: referenceHoles.length,
    onlyTencent: tencentHoles.length,
    tencentPhantomClosures: tencentPhantoms.length,
    ourPhantomSessions: ourPhantomSessions.length,
  };
  const details: string[] = [];
  if (referenceHoles.length) details.push(`in our series but absent from tencent: ${listed(referenceHoles)}`);
  if (tencentHoles.length) details.push(`in tencent but absent from our series: ${listed(tencentHoles)}`);
  const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);
  if (ourPhantomSessions.length) {
    details.push(
      `our series carries ${plural(ourPhantomSessions.length, "a bar", "bars")} on ${plural(ourPhantomSessions.length, "a", "the")} known HKEX closure${plural(ourPhantomSessions.length, "", "s")} (Yahoo phantom that L1 did not drop — check the daily run): ${listed(ourPhantomSessions)}`,
    );
  }
  if (tencentPhantoms.length) {
    details.push(
      `tencent carries ${plural(tencentPhantoms.length, "a bar", "bars")} on ${plural(tencentPhantoms.length, "a", "the")} known HKEX closure${plural(tencentPhantoms.length, "", "s")} (provider calendar bug, not a revision — recorded, not warned): ${listed(tencentPhantoms)}`,
    );
  }

  const alarm = referenceHoles.length + tencentHoles.length > 0;
  const flag = alarm ? "ALARM " : ourPhantomSessions.length ? "WARN " : "";
  const note = !alarm && !ourPhantomSessions.length && tencentPhantoms.length ? ` (+${tencentPhantoms.length} tencent phantom${tencentPhantoms.length > 1 ? "s" : ""})` : "";
  return {
    check: "tencent-dates",
    status: alarm ? "alarm" : ourPhantomSessions.length ? "warn" : "ok",
    summary: `${flag}${metrics.overlapPct}% ${common}d${note}`,
    metrics,
    details,
  };
}

/** Dividend event shape accepted by check 4 (stored rows and provider events
 *  both satisfy it structurally). */
export interface CaEvent {
  date: string;
  amount: number;
}

/** Check 4 — dividend-event revision detector (WARN-only by design).
 *  `window` should be the BAR-level overlap passed by the caller: events are
 *  sparse, so the event-date overlap would collapse to the common dates and
 *  hide exactly the case worth reporting (a newly appeared / vanished
 *  distribution). Without a window every event is compared. */
export function checkCaRevision(
  stored: CaEvent[],
  fresh: CaEvent[],
  window?: SentinelWindow,
  opts: { ignoreAmounts?: boolean } = {},
): SentinelCheck {
  const w = window ?? { from: "0000-01-01", to: "9999-12-31" };
  const sRows = stored.filter((e) => e.date >= w.from && e.date <= w.to);
  const fRows = fresh.filter((e) => e.date >= w.from && e.date <= w.to);
  const sSet = new Set(sRows.map((e) => e.date));
  const fSet = new Set(fRows.map((e) => e.date));
  const onlyStored = sRows.map((e) => e.date).filter((d) => !fSet.has(d));
  const onlyFresh = fRows.map((e) => e.date).filter((d) => !sSet.has(d));
  const amountByDate = new Map(fRows.map((e) => [e.date, e.amount]));
  const restated = sRows.filter((e) => {
    const a = amountByDate.get(e.date);
    return a !== undefined && !closeEquals(e.amount, a);
  });
  // CA_DEGRADED names: restated amounts are expected noise (see header), so
  // they are recorded but do not drive the verdict.
  const amountMismatch = opts.ignoreAmounts ? [] : restated;

  const metrics: Record<string, number> = {
    storedEvents: stored.length,
    freshEvents: fresh.length,
    windowEvents: sRows.length,
    onlyStored: onlyStored.length,
    onlyFresh: onlyFresh.length,
    amountMismatch: amountMismatch.length,
    restatedAmounts: restated.length,
    amountsIgnored: opts.ignoreAmounts ? 1 : 0,
  };
  const details: string[] = [];
  if (onlyStored.length) details.push(`stored dividend events Yahoo no longer reports: ${listed(onlyStored)}`);
  if (onlyFresh.length) details.push(`new dividend events Yahoo reports (not stored — re-run screen:daily): ${listed(onlyFresh)}`);
  for (const e of amountMismatch.slice(0, MAX_EXAMPLES)) {
    details.push(`${e.date}: stored amount ${e.amount} → fresh ${amountByDate.get(e.date)}`);
  }
  if (opts.ignoreAmounts && restated.length) {
    details.push(
      `${restated.length} dividend amount(s) restated by Yahoo and ignored (CA_DEGRADED: FX-converted amounts change every fetch)`,
    );
  }
  const dirty = onlyStored.length + onlyFresh.length + amountMismatch.length;
  const ignoredNote = opts.ignoreAmounts && restated.length ? ` (+${restated.length} restated)` : "";
  return {
    check: "ca-revision",
    status: dirty ? "warn" : "ok",
    summary: dirty ? `WARN ${dirty} event diff` : `ok ${sRows.length} events${ignoredNote}`,
    metrics,
    details,
  };
}
