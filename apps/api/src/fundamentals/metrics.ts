/**
 * Phase 7 fundamentals — the pure half (docs/phase-7-plan.md §2): canonical
 * metrics and the two parsers, one per source. Everything here is pure and
 * known-answer tested; the network and the store live elsewhere.
 *
 * PIT discipline: every point carries `filedAt`, and the ONLY PIT read is
 * "latest point with filedAt <= T per (metric, period)". EDGAR points use the
 * filing's `filed` date. HK points use periodEnd + 90 days — eastmoney exposes
 * no announcement date (probe E2a, 2026-09-20) — and are flagged synthetic so
 * the anchor can never be mistaken for a measured filing date.
 */

export const FUNDAMENTAL_METRICS = [
  "revenue",
  "grossProfit",
  "netIncome",
  "assets",
  "equity",
  "liabilities",
  "epsBasic",
  "sharesOutstanding",
  "operatingCashFlow",
] as const;
export type FundamentalMetric = (typeof FUNDAMENTAL_METRICS)[number];

export type PeriodType = "annual" | "semi" | "quarter" | "instant";

export interface FundamentalPointInput {
  symbol: string;
  market: "US" | "HK";
  source: "sec-edgar" | "eastmoney-f10";
  metric: FundamentalMetric;
  periodEnd: string; // YYYY-MM-DD
  periodType: PeriodType;
  filedAt: string; // YYYY-MM-DD
  filedAtSynthetic: boolean;
  value: number;
  currency: string | null;
  accession: string | null;
}

// ---------------------------------------------------------------------------
// shared date/period helpers
// ---------------------------------------------------------------------------

/** Period type from the duration the fact covers. Instant facts (balance-sheet
 *  stocks, share counts) carry no start. Durations outside the three known
 *  buckets return null — a 5-week stub period is not a quarter. */
export function periodTypeFromDuration(start: string | null, end: string): PeriodType | null {
  if (!start) return "instant";
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
  if (days >= 300) return "annual";
  if (days >= 150 && days < 300) return "semi";
  if (days >= 60 && days < 150) return "quarter";
  return null;
}

/** YYYY-MM-DD + days → YYYY-MM-DD (UTC arithmetic, no timezone drift). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/** HK's synthetic PIT anchor (probe E2a): period end + 90 days, the
 *  conservative side of HKEX's publication deadlines. */
export const HK_FILED_LAG_DAYS = 90;

// ---------------------------------------------------------------------------
// SEC EDGAR companyfacts
// ---------------------------------------------------------------------------

/** us-gaap tag fallbacks per canonical metric, in preference order. */
export const EDGAR_TAGS: Record<FundamentalMetric, string[]> = {
  revenue: [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedCost",
    "RevenueFromContractWithCustomerIncludingAssessedCost",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "SalesRevenueNet",
    "RevenuesNetOfInterestExpense", // banks/brokers (GS, AXP) report no "Revenues"
  ],
  grossProfit: ["GrossProfit"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  assets: ["Assets"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  liabilities: ["Liabilities"],
  epsBasic: ["EarningsPerShareBasic"],
  sharesOutstanding: ["CommonStockSharesOutstanding"],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
};

interface EdgarFactPoint {
  start?: string;
  end?: string;
  val?: number;
  accn?: string;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
}

/** Forms that publish statements. 8-K earnings releases are excluded: their
 *  figures duplicate the 10-Q/10-K that follows, and including them would
 *  double-count periods. 20-F/40-F cover foreign private issuers. */
const EDGAR_FORMS = new Set(["10-K", "10-Q", "20-F", "40-F"]);

/**
 * companyfacts JSON → canonical points. Every qualifying (form, dated, finite)
 * fact point is kept, INCLUDING restatements — dedup by period happens at PIT
 * read time, never here. Tag fallbacks pick the tag with the MOST points, not
 * the first: registrants migrate tags over time (measured 2026-09-20: AMD's
 * `Revenues` holds only the 4 most recent quarters while `SalesRevenueNet`
 * holds the full 78-fact history) — "first non-empty" silently truncates.
 */
export function extractEdgarPoints(
  symbol: string,
  companyfacts: unknown,
): FundamentalPointInput[] {
  const out: FundamentalPointInput[] = [];
  // companyfacts occasionally repeats an identical fact (same end/filed/form)
  // under a second unit — collapse on the store's unique key, first wins.
  const seen = new Set<string>();
  const gaap = (companyfacts as any)?.facts?.["us-gaap"];
  if (gaap == null || typeof gaap !== "object") return out;
  for (const metric of FUNDAMENTAL_METRICS) {
    let bestPoints: FundamentalPointInput[] = [];
    for (const tag of EDGAR_TAGS[metric]) {
      const entry = gaap[tag];
      if (!entry?.units) continue;
      const tagPoints: FundamentalPointInput[] = [];
      const tagSeen = new Set<string>();
      for (const points of Object.values(entry.units) as EdgarFactPoint[][]) {
        if (!Array.isArray(points)) continue;
        for (const p of points) {
          if (typeof p?.val !== "number" || !Number.isFinite(p.val)) continue;
          if (typeof p.end !== "string" || typeof p.filed !== "string") continue;
          if (p.form == null || !EDGAR_FORMS.has(p.form)) continue;
          const periodType = periodTypeFromDuration(p.start ?? null, p.end);
          if (periodType === null) continue;
          const key = `${metric}|${p.end}|${periodType}|${p.filed}`;
          if (tagSeen.has(key)) continue;
          tagSeen.add(key);
          tagPoints.push({
            symbol,
            market: "US",
            source: "sec-edgar",
            metric,
            periodEnd: p.end,
            periodType,
            filedAt: p.filed,
            filedAtSynthetic: false,
            value: p.val,
            currency: metric === "sharesOutstanding" ? "shares" : null,
            accession: typeof p.accn === "string" ? p.accn : null,
          });
        }
      }
      if (tagPoints.length > bestPoints.length) bestPoints = tagPoints;
    }
    for (const p of bestPoints) {
      const key = `${p.metric}|${p.periodEnd}|${p.periodType}|${p.filedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// eastmoney HK F10 main indicators (probe E2a, 2026-09-20: 89 columns, no
// announcement date; the table alone covers the whole composite)
// ---------------------------------------------------------------------------

const HK_METRIC_COLUMNS: [string, FundamentalMetric][] = [
  ["OPERATE_INCOME", "revenue"],
  ["GROSS_PROFIT", "grossProfit"],
  ["HOLDER_PROFIT", "netIncome"],
  ["TOTAL_ASSETS", "assets"],
  ["TOTAL_PARENT_EQUITY", "equity"],
  ["TOTAL_LIABILITIES", "liabilities"],
  ["BASIC_EPS", "epsBasic"],
  ["ISSUED_COMMON_SHARES", "sharesOutstanding"],
  ["NETCASH_OPERATE", "operatingCashFlow"],
];

/** DATE_TYPE_CODE "001" = annual, "002" = semi (measured 2026-09-06/20);
 *  003/007/008 are quarter-ish codes from the same probe. */
const HK_PERIOD_TYPES: Record<string, PeriodType> = { "001": "annual", "002": "semi", "003": "quarter", "007": "quarter", "008": "quarter" };

/** One HKF10 main-indicator row → one point per non-null metric, all anchored
 *  at periodEnd + HK_FILED_LAG_DAYS and flagged synthetic (no announcement
 *  date exists — see the file header). Unknown DATE_TYPE_CODEs are skipped:
 *  a period we cannot classify is not a period we may anchor. */
export function extractEastmoneyHkPoints(symbol: string, row: unknown): FundamentalPointInput[] {
  const r = row as Record<string, unknown>;
  const periodEnd = typeof r.REPORT_DATE === "string" ? r.REPORT_DATE.slice(0, 10) : "";
  const periodType = HK_PERIOD_TYPES[typeof r.DATE_TYPE_CODE === "string" ? r.DATE_TYPE_CODE : ""];
  if (!periodEnd || !periodType) return [];
  const currency = typeof r.CURRENCY === "string" && r.CURRENCY ? r.CURRENCY : null;
  const filedAt = addDays(periodEnd, HK_FILED_LAG_DAYS);
  const out: FundamentalPointInput[] = [];
  for (const [col, metric] of HK_METRIC_COLUMNS) {
    const v = r[col];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out.push({
      symbol,
      market: "HK",
      source: "eastmoney-f10",
      metric,
      periodEnd,
      periodType,
      filedAt,
      filedAtSynthetic: true,
      value: v,
      currency: metric === "sharesOutstanding" ? "shares" : currency,
      accession: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// PIT read: latest point per (metric, period) knowable at T
// ---------------------------------------------------------------------------

/**
 * The ONLY sanctioned read of stored points: for each (metric, periodEnd,
 * periodType), the point with the latest filedAt ≤ asOf. Restatements filed
 * after T are invisible; a period first filed after T does not exist yet.
 * `asOf` is INCLUSIVE — a filing on T is knowable at T's close.
 */
export function pointsKnownAt<T extends { metric: string; periodEnd: string; periodType: string; filedAt: string }>(
  points: T[],
  asOf: string,
): T[] {
  const best = new Map<string, T>();
  for (const p of points) {
    if (p.filedAt > asOf) continue;
    const key = `${p.metric}|${p.periodEnd}|${p.periodType}`;
    const cur = best.get(key);
    if (!cur || cur.filedAt < p.filedAt) best.set(key, p);
  }
  return [...best.values()];
}
