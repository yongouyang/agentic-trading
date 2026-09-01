/**
 * Exchange holiday calendars — static full-day closure date sets for HKEX and
 * NYSE, covering 2021-01-01 through 2027-12-31 (YYYY-MM-DD).
 *
 * Source: published HKEX and NYSE holiday schedules (hkex.com.hk /
 * nyse.com trading-calendars). **Refresh annually** — these are committed
 * constants, not derived; regenerate from the official calendars each
 * December and extend the coverage window.
 *
 * Used by loader rule L1 (`dropHolidayPhantomBars`): Yahoo fabricates
 * zero-volume phantom bars on HKEX holidays (measured 2022-01-31 Lunar New
 * Year eve, every HK ticker). US half-days (e.g. Black Friday) are full
 * sessions at daily granularity and are NOT listed.
 *
 * `HKEX_ADHOC_CLOSURES` / `HKEX_KNOWN_NON_SESSIONS` (below) extend the holiday
 * lists with cyclone/rainstorm closures, for the weekly sentinel's calendar
 * attribution — they are closure sets, not an additional L1 phantom-drop input
 * (L1 keeps its own, narrower holiday semantics).
 */

/** HKEX full-day holidays 2021–2027. Includes: New Year's Day, Lunar New
 *  Year days, Ching Ming, Good Friday + Easter Monday, Labour Day, Buddha's
 *  Birthday, Tuen Ng, HKSAR Establishment Day, day following Mid-Autumn,
 *  National Day, Chung Yeung, Christmas + first weekday after (Boxing),
 *  with HK observed-date substitutions. Saturday occurrences with no
 *  substitute are omitted. */
export const HKEX_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2021 (13)
  "2021-01-01", // New Year's Day
  "2021-02-12", // Lunar New Year day 1
  "2021-02-15", // Lunar New Year (day 3 fell Sunday → observed)
  "2021-04-02", // Good Friday
  "2021-04-05", // Easter Monday (also Ching Ming observed)
  "2021-04-06", // Ching Ming substitute (Sunday, Monday taken by Easter)
  "2021-05-19", // Buddha's Birthday
  "2021-06-14", // Tuen Ng
  "2021-07-01", // HKSAR Establishment Day
  "2021-09-22", // day following Mid-Autumn
  "2021-10-01", // National Day
  "2021-10-14", // Chung Yeung
  "2021-12-27", // Christmas (Sat/Sun → observed)
  // 2022 (16)
  "2022-01-31", // Lunar New Year's Eve — measured phantom-bar date
  "2022-02-01", // LNY day 1
  "2022-02-02", // LNY day 2
  "2022-02-03", // LNY day 3
  "2022-04-05", // Ching Ming
  "2022-04-15", // Good Friday
  "2022-04-18", // Easter Monday
  "2022-05-02", // Labour Day (May 1 Sunday → observed)
  "2022-05-09", // Buddha's Birthday (May 8 Sunday → observed)
  "2022-06-03", // Tuen Ng
  "2022-07-01", // HKSAR Establishment Day
  "2022-09-12", // day following Mid-Autumn (Sep 11 Sunday → observed)
  "2022-10-03", // National Day (Oct 1 Saturday → observed)
  "2022-10-04", // Chung Yeung
  "2022-12-26", // Christmas (Sunday → observed)
  "2022-12-27", // first weekday after Christmas
  // 2023 (14)
  "2023-01-02", // New Year's Day (Jan 1 Sunday → observed)
  "2023-01-23", // LNY day 2
  "2023-01-24", // LNY day 3
  "2023-01-25", // LNY substitute (day 1 fell Sunday)
  "2023-04-05", // Ching Ming
  "2023-04-07", // Good Friday
  "2023-04-10", // Easter Monday
  "2023-05-01", // Labour Day
  "2023-05-26", // Buddha's Birthday
  "2023-06-22", // Tuen Ng
  "2023-10-02", // National Day (Oct 1 Sunday → observed)
  "2023-10-23", // Chung Yeung
  "2023-12-25", // Christmas
  "2023-12-26", // first weekday after Christmas
  // 2024 (15)
  "2024-01-01", // New Year's Day
  "2024-02-12", // LNY day 3
  "2024-02-13", // LNY substitute (day 1 Saturday, day 2 Sunday)
  "2024-03-29", // Good Friday
  "2024-04-01", // Easter Monday
  "2024-04-04", // Ching Ming
  "2024-05-01", // Labour Day
  "2024-05-15", // Buddha's Birthday
  "2024-06-10", // Tuen Ng
  "2024-07-01", // HKSAR Establishment Day
  "2024-09-18", // day following Mid-Autumn
  "2024-10-01", // National Day
  "2024-10-11", // Chung Yeung
  "2024-12-25", // Christmas
  "2024-12-26", // first weekday after Christmas
  // 2025 (14)
  "2025-01-01", // New Year's Day
  "2025-01-29", // LNY day 1
  "2025-01-30", // LNY day 2
  "2025-01-31", // LNY day 3
  "2025-04-04", // Ching Ming
  "2025-04-18", // Good Friday
  "2025-04-21", // Easter Monday
  "2025-05-01", // Labour Day
  "2025-05-05", // Buddha's Birthday
  "2025-07-01", // HKSAR Establishment Day
  "2025-10-01", // National Day
  "2025-10-07", // day following Mid-Autumn
  "2025-10-29", // Chung Yeung
  "2025-12-25", // Christmas
  "2025-12-26", // first weekday after Christmas
  // 2026 (15)
  "2026-01-01", // New Year's Day
  "2026-02-17", // LNY day 1
  "2026-02-18", // LNY day 2
  "2026-02-19", // LNY day 3
  "2026-04-03", // Good Friday
  "2026-04-06", // Easter Monday
  "2026-04-07", // Ching Ming substitute (Apr 5 Sunday, Monday taken by Easter)
  "2026-05-01", // Labour Day
  "2026-05-25", // Buddha's Birthday (May 24 Sunday → observed)
  "2026-06-19", // Tuen Ng
  "2026-07-01", // HKSAR Establishment Day
  "2026-10-01", // National Day
  "2026-10-19", // Chung Yeung (Oct 18 Sunday → observed)
  "2026-12-25", // Christmas
  "2026-12-28", // first weekday after Christmas (Boxing fell Saturday)
  // 2027 (13)
  "2027-01-01", // New Year's Day
  "2027-02-08", // LNY day 3
  "2027-02-09", // LNY substitute (day 1 Saturday, day 2 Sunday)
  "2027-03-26", // Good Friday
  "2027-03-29", // Easter Monday
  "2027-04-05", // Ching Ming
  "2027-05-13", // Buddha's Birthday
  "2027-06-09", // Tuen Ng
  "2027-07-01", // HKSAR Establishment Day
  "2027-09-16", // day following Mid-Autumn
  "2027-10-01", // National Day
  "2027-10-08", // Chung Yeung
  "2027-12-27", // Christmas (Dec 25 Saturday, Dec 26 Sunday → observed)
]);

/** HKEX **ad-hoc** full-day closures — not in the published holiday schedule,
 *  declared hours before the session (tropical cyclone / black rain). These
 *  matter because a published calendar cannot explain a provider that carries
 *  a bar on such a date: the weekly sentinel would otherwise ALARM forever on
 *  a fully classified third-party bug.
 *
 *  Measured 2026-08-31 (docs/phase-0-verification-report.md §G2b): tencent
 *  serves bars on all three of these sessions, Yahoo correctly does not —
 *  "HKEX closed, tencent carries phantom bars → tencent calendar bug".
 *
 *  Evidence-driven on purpose: a NEW cyclone closure surfaces as one sentinel
 *  ALARM, a human classifies it (tencent phantom vs a real session missing
 *  from our store), and only then is it appended here with its citation. Do
 *  not pre-fill this list from memory. */
export const HKEX_ADHOC_CLOSURES: ReadonlySet<string> = new Set([
  "2023-07-17", // Typhoon Talim — T10 in force, HKEX closed all day
  "2023-09-01", // Typhoon Saola — T10 in force, HKEX closed all day
  "2023-09-08", // Black rainstorm + T8 resumed — HKEX closed all day
]);

/** Every date HKEX was shut all day, scheduled or ad-hoc — the set the sentinel
 *  uses to attribute a phantom session to the provider that carried it instead
 *  of alarming. */
export const HKEX_KNOWN_NON_SESSIONS: ReadonlySet<string> = new Set([...HKEX_HOLIDAYS, ...HKEX_ADHOC_CLOSURES]);

/** NYSE full-day holidays 2021–2027: New Year's Day, MLK Day, Washington's
 *  Birthday, Good Friday, Memorial Day, Juneteenth, Independence Day,
 *  Labor Day, Thanksgiving, Christmas — with weekend observed-date shifts.
 *  (NYSE did not close for Juneteenth in 2021; first observed 2022.)
 *  Half-day early closes are excluded — they are full sessions at daily
 *  granularity. */
export const NYSE_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2021 (9)
  "2021-01-01", // New Year's Day
  "2021-01-18", // MLK Day
  "2021-02-15", // Washington's Birthday
  "2021-04-02", // Good Friday
  "2021-05-31", // Memorial Day
  "2021-07-05", // Independence Day (Jul 4 Sunday → observed)
  "2021-09-06", // Labor Day
  "2021-11-25", // Thanksgiving
  "2021-12-24", // Christmas (Dec 25 Saturday → observed)
  // 2022 (9)
  "2022-01-17", // MLK Day
  "2022-02-21", // Washington's Birthday
  "2022-04-15", // Good Friday
  "2022-05-30", // Memorial Day
  "2022-06-20", // Juneteenth (Jun 19 Sunday → observed)
  "2022-07-04", // Independence Day
  "2022-09-05", // Labor Day
  "2022-11-24", // Thanksgiving
  "2022-12-26", // Christmas (Dec 25 Sunday → observed)
  // 2023 (10)
  "2023-01-02", // New Year's Day (Jan 1 Sunday → observed)
  "2023-01-16", // MLK Day
  "2023-02-20", // Washington's Birthday
  "2023-04-07", // Good Friday
  "2023-05-29", // Memorial Day
  "2023-06-19", // Juneteenth
  "2023-07-04", // Independence Day
  "2023-09-04", // Labor Day
  "2023-11-23", // Thanksgiving
  "2023-12-25", // Christmas
  // 2024 (10)
  "2024-01-01", // New Year's Day
  "2024-01-15", // MLK Day
  "2024-02-19", // Washington's Birthday
  "2024-03-29", // Good Friday
  "2024-05-27", // Memorial Day
  "2024-06-19", // Juneteenth
  "2024-07-04", // Independence Day
  "2024-09-02", // Labor Day
  "2024-11-28", // Thanksgiving
  "2024-12-25", // Christmas
  // 2025 (10)
  "2025-01-01", // New Year's Day
  "2025-01-20", // MLK Day
  "2025-02-17", // Washington's Birthday
  "2025-04-18", // Good Friday
  "2025-05-26", // Memorial Day
  "2025-06-19", // Juneteenth
  "2025-07-04", // Independence Day
  "2025-09-01", // Labor Day
  "2025-11-27", // Thanksgiving
  "2025-12-25", // Christmas
  // 2026 (10)
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (Jul 4 Saturday → observed)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
  // 2027 (10)
  "2027-01-01", // New Year's Day
  "2027-01-18", // MLK Day
  "2027-02-15", // Washington's Birthday
  "2027-03-26", // Good Friday
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth (Jun 19 Saturday → observed)
  "2027-07-05", // Independence Day (Jul 4 Sunday → observed)
  "2027-09-06", // Labor Day
  "2027-11-25", // Thanksgiving
  "2027-12-24", // Christmas (Dec 25 Saturday → observed)
]);
