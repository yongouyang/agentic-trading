/**
 * Phase 7 P3 (docs/phase-7-plan.md §3–§4): the quality composite, the
 * valuation ceiling (E/P), and the two trend gates. Pure functions over PIT
 * fundamental points and price series — no I/O, no store.
 *
 * Every input point is assumed to be knowable at the evaluation date (the
 * caller reads the store through `pointsKnownAt` — the only sanctioned PIT
 * read). Duration metrics (revenue, grossProfit, netIncome, operatingCashFlow)
 * are reduced to a trailing-twelve-month value; stock metrics (assets, equity,
 * liabilities, sharesOutstanding) are taken at the latest known period.
 */

export interface PitPoint {
  metric: string;
  periodEnd: string; // YYYY-MM-DD
  periodType: "annual" | "semi" | "quarter" | "instant";
  filedAt: string;
  value: number;
}

const DAY_MS = 86_400_000;
const parse = (d: string) => Date.parse(d);

// ---------------------------------------------------------------------------
// TTM reduction
// ---------------------------------------------------------------------------

/**
 * Trailing-twelve-month value of a duration metric as of `asOf`.
 *
 * Preference order (most granular that spans a full year):
 *   1. sum of the last 4 quarters,
 *   2. sum of the last 2 semi-annual periods,
 *   3. the latest annual period.
 * Returns null when nothing spans a year. Only periods ending ≤ asOf that the
 * PIT read surfaced are considered (filing visibility is the caller's job).
 */
export function trailingTwelveMonths(points: PitPoint[], metric: string, asOf: string): number | null {
  const durations = points
    .filter((p) => p.metric === metric && p.periodEnd <= asOf && p.periodType !== "instant")
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  const take = (type: string, n: number, gapRange: [number, number]): number | null => {
    const rows = durations.filter((p) => p.periodType === type);
    if (rows.length < n) return null;
    const slice = rows.slice(0, n);
    // The run must be CONTINUOUS: consecutive period ends spaced like the
    // period type (a skipped filing must not silently bridge a year).
    for (let i = 0; i + 1 < slice.length; i++) {
      const gap = (parse(slice[i]!.periodEnd) - parse(slice[i + 1]!.periodEnd)) / DAY_MS;
      if (gap < gapRange[0] || gap > gapRange[1]) return null;
    }
    return slice.reduce((s, p) => s + p.value, 0);
  };
  return take("quarter", 4, [60, 120]) ?? take("semi", 2, [150, 220]) ?? take("annual", 1, [0, 0]);
}

/** Latest known stock value of a metric as of `asOf`, by period end.
 *  EDGAR stocks are `instant` facts; HK rows carry the period type of their
 *  report (annual/semi) even for balance-sheet stocks — so period type is not
 *  a filter here. Callers must only use this for stock metrics (assets,
 *  equity, liabilities, sharesOutstanding), never flows. */
export function latestStock(points: PitPoint[], metric: string, asOf: string): number | null {
  let best: PitPoint | null = null;
  for (const p of points) {
    if (p.metric !== metric || p.periodEnd > asOf) continue;
    if (!best || p.periodEnd > best.periodEnd) best = p;
  }
  return best?.value ?? null;
}

// ---------------------------------------------------------------------------
// composite components (higher = better after the sign conventions of §3)
// ---------------------------------------------------------------------------

export interface CompositeComponents {
  grossProfitability: number | null; // TTM gross profit / assets
  roe: number | null; // TTM net income / equity
  marginStability: number | null; // −3y std of gross margin
  safety: number | null; // −(liabilities / assets)
  growth: number | null; // 3y revenue CAGR (capped later, cross-sectionally)
}

/** Per-period gross margins over the trailing 3 years (duration periods only). */
function grossMargins3y(points: PitPoint[], asOf: string): number[] {
  const cutoff = new Date(parse(asOf) - 3 * 365 * DAY_MS).toISOString().slice(0, 10);
  const gp = new Map<string, number>();
  const rev = new Map<string, number>();
  for (const p of points) {
    if (p.periodType === "instant" || p.periodEnd > asOf || p.periodEnd < cutoff) continue;
    if (p.metric === "grossProfit") gp.set(`${p.periodType}|${p.periodEnd}`, p.value);
    if (p.metric === "revenue") rev.set(`${p.periodType}|${p.periodEnd}`, p.value);
  }
  const margins: number[] = [];
  for (const [key, g] of gp) {
    const r = rev.get(key);
    if (r != null && r > 0) margins.push(g / r);
  }
  return margins;
}

/** The five §3 components for one name at `asOf`. Null = not computable. */
export function compositeComponents(points: PitPoint[], asOf: string): CompositeComponents {
  const gpTtm = trailingTwelveMonths(points, "grossProfit", asOf);
  const niTtm = trailingTwelveMonths(points, "netIncome", asOf);
  const assets = latestStock(points, "assets", asOf);
  const equity = latestStock(points, "equity", asOf);
  const liabilities = latestStock(points, "liabilities", asOf);

  const margins = grossMargins3y(points, asOf);
  let marginStability: number | null = null;
  if (margins.length >= 4) {
    const mean = margins.reduce((s, m) => s + m, 0) / margins.length;
    const variance = margins.reduce((s, m) => s + (m - mean) ** 2, 0) / (margins.length - 1);
    marginStability = -Math.sqrt(variance);
  }

  // 3y revenue CAGR: annual/TTM revenue now vs ~3y ago. Uses TTM at both
  // ends so HK semi-annual reporters are comparable with US quarterlies.
  let growth: number | null = null;
  const revNow = trailingTwelveMonths(points, "revenue", asOf);
  const asOfThen = new Date(parse(asOf) - 3 * 365 * DAY_MS).toISOString().slice(0, 10);
  const revThen = trailingTwelveMonths(points, "revenue", asOfThen);
  if (revNow != null && revThen != null && revNow > 0 && revThen > 0) {
    growth = Math.pow(revNow / revThen, 1 / 3) - 1;
  }

  return {
    grossProfitability: gpTtm != null && assets != null && assets > 0 ? gpTtm / assets : null,
    roe: niTtm != null && equity != null && equity > 0 ? niTtm / equity : null,
    marginStability,
    safety: liabilities != null && assets != null && assets > 0 ? -(liabilities / assets) : null,
    growth,
  };
}

// ---------------------------------------------------------------------------
// valuation: E/P and the market-weighted final score
// ---------------------------------------------------------------------------

/**
 * Earnings yield: TTM net income / market cap (shares outstanding × price).
 * Null when any leg is missing or non-positive. The valuation ceiling is
 * cross-sectional (exclude the bottom E/P quintile) and lives in the caller.
 */
export function earningsYield(points: PitPoint[], asOf: string, price: number): number | null {
  const niTtm = trailingTwelveMonths(points, "netIncome", asOf);
  const shares = latestStock(points, "sharesOutstanding", asOf);
  if (niTtm == null || shares == null || shares <= 0 || price <= 0) return null;
  return niTtm / (shares * price);
}

/** Market-weighted final score (§3, declared weights — not tunable):
 *  US quality 70% / valuation 30%; HK quality 60% / valuation 40%. */
export const SCORE_WEIGHTS = {
  US: { quality: 0.7, valuation: 0.3 },
  HK: { quality: 0.6, valuation: 0.4 },
} as const;

export function combineScore(market: "US" | "HK", qualityZ: number, valuationZ: number): number {
  const w = SCORE_WEIGHTS[market];
  return w.quality * qualityZ + w.valuation * valuationZ;
}

// ---------------------------------------------------------------------------
// cross-sectional z-scores with winsorization
// ---------------------------------------------------------------------------

/**
 * Winsorized z-scores of one component across the universe at one date.
 * Raw values are clipped at the 5th/95th percentiles before standardizing
 * (§3 "winsorized cross-sectionally"; the growth component's p95 cap is
 * subsumed by this). Names with a null component get null; a constant
 * cross-section (zero variance) standardizes to 0.
 */
export function winsorizedZScores(values: (number | null)[], lowerPct = 0.05, upperPct = 0.95): (number | null)[] {
  const present = values.filter((v): v is number => v != null).sort((a, b) => a - b);
  if (present.length < 2) return values.map(() => null);
  const quantile = (q: number) => present[Math.round(q * (present.length - 1))]!;
  const lo = quantile(lowerPct);
  const hi = quantile(upperPct);
  const clipped = present.map((v) => Math.min(hi, Math.max(lo, v)));
  const mean = clipped.reduce((s, v) => s + v, 0) / clipped.length;
  const variance = clipped.reduce((s, v) => s + (v - mean) ** 2, 0) / clipped.length;
  const sd = Math.sqrt(variance);
  return values.map((v) => (v == null ? null : sd > 0 ? (Math.min(hi, Math.max(lo, v)) - mean) / sd : 0));
}

/**
 * The §3 quality composite: equal-weighted mean of the available component
 * z-scores. A name needs ≥3 of 5 components to be scored at all.
 */
export function qualityCompositeZ(
  components: CompositeComponents[],
  minComponents = 3,
): (number | null)[] {
  const keys: (keyof CompositeComponents)[] = ["grossProfitability", "roe", "marginStability", "safety", "growth"];
  const zByKey = new Map(keys.map((k) => [k, winsorizedZScores(components.map((c) => c[k]))]));
  return components.map((_, i) => {
    const zs = keys.map((k) => zByKey.get(k)![i]).filter((z): z is number => z != null);
    if (zs.length < minComponents) return null;
    return zs.reduce((s, z) => s + z, 0) / zs.length;
  });
}

// ---------------------------------------------------------------------------
// trend gates (§4, D2: exit authority)
// ---------------------------------------------------------------------------

export type GateId = "G1" | "G2";

export interface GateState {
  gate: GateId;
  /** true = trend intact (may hold/enter); false = gate broken (must exit). */
  pass: boolean;
  detail: number | null; // G1: close/MA200 ratio; G2: 12M return
}

/**
 * G1: price at or above the 200-DAY moving average of daily closes. The gate
 * is EVALUATED on week-ending sessions (the caller decides when to call);
 * the MA itself is over the last 200 daily closes. Fails closed without 200
 * sessions of history.
 */
export function gateG1(dailyCloses: number[]): GateState {
  if (dailyCloses.length < 200) return { gate: "G1", pass: false, detail: null };
  const window = dailyCloses.slice(-200);
  const ma = window.reduce((s, c) => s + c, 0) / window.length;
  const last = dailyCloses[dailyCloses.length - 1]!;
  return { gate: "G1", pass: last >= ma, detail: ma > 0 ? last / ma : null };
}

/**
 * G2: trailing 12-month return must be positive. `dailyCloses` oldest first;
 * the lookback is 252 trading sessions. Fails closed without enough history.
 */
export function gateG2(dailyCloses: number[]): GateState {
  if (dailyCloses.length < 253) return { gate: "G2", pass: false, detail: null };
  const last = dailyCloses[dailyCloses.length - 1]!;
  const base = dailyCloses[dailyCloses.length - 253]!;
  const ret = base > 0 ? last / base - 1 : null;
  return { gate: "G2", pass: ret != null && ret > 0, detail: ret };
}

export function gateState(gate: GateId, dailyCloses: number[]): GateState {
  return gate === "G1" ? gateG1(dailyCloses) : gateG2(dailyCloses);
}
