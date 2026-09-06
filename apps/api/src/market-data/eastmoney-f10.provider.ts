/**
 * EastmoneyF10Provider — HK dividend/distribution event source
 * (Phase-2 CA-source decision, 2026-09-06, architecture §4). Yahoo stays the
 * primary CA source; this provider feeds the WEEKLY non-blocking enrichment
 * (cli/refresh-f10-ca.ts): corrected HKD amounts for CA_DEGRADED
 * (USD/RMB-declaring) names and in-specie distributions Yahoo never reports.
 *
 * Host: `datacenter.eastmoney.com` report RPT_HKF10_MAIN_DIVBASIC — NOT the
 * ban-prone `push2his` (12/12 calls at ~1s spacing measured clean
 * 2026-09-06). Same pacing discipline as EastmoneyRepairProvider anyway:
 * ≥1s base + 0–50% jitter, spacing/sleep/fetch injectable via constructor.
 *
 * Measured payload facts (probed 2026-09-06, used as test fixtures):
 *   cash HKD:      `每股派港币5.3元`
 *   cash USD:      `每股派美元0.1元(相当于港币0.784234元(计算值))`
 *   cash CNY:      `每股派人民币0.358元(相当于港币0.41141元)`
 *   in-specie+HKD: `特殊说明:每10股分派1股美团B类普通股股份(相当于每股派18.13港元)`
 *   in-specie:     `特殊说明:每21股腾讯股份分派1股京东集团A类普通股股份`
 *   bonus:         `每10股派送8股,每10股转12股`
 * Dates arrive as `YYYY/MM/DD` and are normalized to `YYYY-MM-DD`.
 *
 * Failure-as-value: HTTP non-200 / transport / malformed JSON →
 * `{ failure: <slug> }`, NEVER throw (throwing stays reserved for programming
 * errors like a non-HK symbol reaching hkSymbolMaps). An empty data array for
 * a real stock is legitimate absence (01810 pays no dividends — measured) →
 * `{ rows: [] }`; `result: null` (no report for the name — ETFs, measured on
 * 2800.HK) is treated the same.
 */
import { hkSymbolMaps } from "./hk-symbol-map.js";

const UA = "Mozilla/5.0";
const F10_TIMEOUT_MS = 25_000;

export interface F10DividendRow {
  /** NOTICE_DATE, normalized YYYY-MM-DD (null when absent). */
  noticeDate: string | null;
  /** EX_DIVIDEND_DATE, normalized YYYY-MM-DD (null when absent). */
  exDate: string | null;
  /** DIVIDEND_DATE (payment date), normalized YYYY-MM-DD (null when absent). */
  payDate: string | null;
  /** REPORT_TYPE, e.g. "年度分配" | "特别分配" | "中期分配". */
  reportType: string;
  /** PLAN_EXPLAIN verbatim — the parse input and the audit trail. */
  plan: string;
}

export interface F10Provider {
  fetchDividendRows(symbol: string): Promise<{ rows: F10DividendRow[] } | { failure: string }>;
}

export interface EastmoneyF10ProviderOptions {
  /** Base spacing between requests in ms (default 1000; 0 in tests). */
  spacingMs?: number;
  /** fetch implementation (default global fetch). */
  fetchImpl?: typeof fetch;
  /** sleep function (default real setTimeout; tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Same jitter idiom as EastmoneyRepairProvider: base + uniform 0–50%. */
const jitter = (base: number) => base + Math.random() * base * 0.5;

/** `YYYY/MM/DD` → `YYYY-MM-DD`; passes through already-normal dates; empty
 *  and "-" (eastmoney's null marker) become null. */
export function normalizeF10Date(s: unknown): string | null {
  if (typeof s !== "string" || s === "" || s === "-") return null;
  return s.replaceAll("/", "-");
}

// ---------------------------------------------------------------------------
// parseF10Plan — pure, exported. PLAN_EXPLAIN is free Chinese text; every
// parse branch is anchored on the measured strings above.
// ---------------------------------------------------------------------------

export type ParsedPlan =
  | {
      kind: "cash";
      declaringCurrency: "HKD" | "USD" | "CNY";
      declaringAmount: number;
      /** HKD equivalent when the plan publishes one (`相当于港币X元`). */
      hkdEquivalent: number | null;
      /** True when the SAME row also carries a bonus/capitalization clause
       *  (measured 1211.HK 2025-06-10: `每股派人民币3.974元(…),每10股派送8股,
       *  每10股转12股`) — the cash amount is then as-declared in pre-split
       *  share terms and must not be overlaid onto the split-adjusted store. */
      embeddedBonus: boolean;
    }
  | {
      kind: "in-specie";
      /** Denominator of the distribution ratio (per N shares held). */
      perShares: number;
      /** Numerator — shares of the distributed asset received. */
      getShares: number;
      /** Distributed asset description, verbatim remainder (kept raw when in
       *  doubt — the audit trail matters more than pretty names). */
      asset: string;
      hkdEquivalentPerShare: number | null;
      /** Same-row bonus clause (not measured on in-specie rows; defensive). */
      embeddedBonus: boolean;
    }
  | { kind: "bonus" }
  | { kind: "unknown" };

const DECLARING_CURRENCY: Record<string, "HKD" | "USD" | "CNY"> = { 港币: "HKD", 美元: "USD", 人民币: "CNY" };

/** `每股派(港币|美元|人民币)X元`. */
const CASH_RE = /每股派(港币|美元|人民币)([\d.]+)元/;
/** Alternate ordering (measured 0005.HK 2004 row): `每股派0.13美元`. */
const CASH_ALT_RE = /每股派([\d.]+)(港币|美元|人民币)/;
/** `相当于港币X元` — may be followed by nested parens (`(计算值)`). */
const HKD_EQUIV_RE = /相当于港币([\d.]+)元/;
/** In-specie: `每N股[...]分派M股<asset>` + optional `(相当于每股派X港元)`. */
const IN_SPECIE_RE = /每(\d+)股[^\n]*?分派(\d+)股(.+?)(?:\(相当于每股派([\d.]+)港元\))?$/;
/** Bonus / capitalization rows: `派送` or `转N股` — split-class, out of scope. */
const BONUS_RE = /(派送|转\d+股)/;

/** Parse one F10 PLAN_EXPLAIN string. Check order matters: in-specie before
 *  cash (its HKD-equivalent clause contains `每股派…港元`, which is NOT a cash
 *  declaration), cash before bonus. Unknown/bonus are loud at the caller. */
export function parseF10Plan(plan: string): ParsedPlan {
  const specie = IN_SPECIE_RE.exec(plan);
  if (specie) {
    return {
      kind: "in-specie",
      perShares: Number(specie[1]),
      getShares: Number(specie[2]),
      asset: (specie[3] ?? "").trim(),
      hkdEquivalentPerShare: specie[4] !== undefined ? Number(specie[4]) : null,
      embeddedBonus: BONUS_RE.test(specie[3] ?? ""),
    };
  }
  const cash = CASH_RE.exec(plan);
  const cashAlt = cash ? null : CASH_ALT_RE.exec(plan);
  if (cash || cashAlt) {
    const currencyToken = cash ? cash[1]! : cashAlt![2]!;
    const amountToken = cash ? cash[2]! : cashAlt![1]!;
    const equiv = HKD_EQUIV_RE.exec(plan);
    return {
      kind: "cash",
      declaringCurrency: DECLARING_CURRENCY[currencyToken]!,
      declaringAmount: Number(amountToken),
      hkdEquivalent: equiv ? Number(equiv[1]) : null,
      embeddedBonus: BONUS_RE.test(plan),
    };
  }
  if (BONUS_RE.test(plan)) return { kind: "bonus" };
  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fundamentals snapshot (Phase 2, phase-2-plan.md): main-indicator tables for
// HK + US stocks, rendered to a compact pre-rendered text block (~20 lines,
// it's prompt budget) — latest annual + latest interim/quarter with YoY
// deltas. Probed 2026-09-06 (fixtures in tests/unit/fixtures/f10-*.json):
//   HK: RPT_HKF10_FN_MAININDICATOR, source=F10, filter SECURITY_CODE="00700"
//       (5-digit), fields OPERATE_INCOME(_YOY), HOLDER_PROFIT(_YOY),
//       GROSS_PROFIT_RATIO, NET_PROFIT_RATIO, ROE_AVG, DEBT_ASSET_RATIO,
//       BASIC_EPS, NETCASH_OPERATE; CURRENCY is ISO ("HKD").
//   US: two-step — RPT_USF10_INFO_ORGPROFILE (source=SECURITIES) maps the
//       bare ticker to a SECUCODE ("TSLA.O"), then
//       RPT_USF10_FN_GMAININDICATOR, filter SECUCODE + same-ish fields but
//       PARENT_HOLDER_NETPROFIT and CURRENCY in Chinese ("美元").
//   DATE_TYPE_CODE "001" = annual; everything else is an interim/quarter row
//       (002 cumulative H1, 003 Q1, 007 Q4, 008 Q2 — measured).
//   YoY/ratio fields arrive in PERCENT units (13.8596 = +13.9%); amounts are
//   absolute in the report currency.
// ETFs have no records (result:null — same absence semantics as dividends).
// ---------------------------------------------------------------------------

export interface F10IndicatorRow {
  /** YYYY-MM-DD. */
  reportDate: string;
  /** "001" = annual; other codes = interim/quarter. */
  dateTypeCode: string;
  /** Provider label, e.g. "2025年年报" | "2026/Q2". */
  reportType: string;
  currency: string;
  revenue: number | null;
  revenueYoy: number | null;
  netProfit: number | null;
  netProfitYoy: number | null;
  grossMargin: number | null;
  netMargin: number | null;
  roe: number | null;
  debtRatio: number | null;
  eps: number | null;
  /** HK only: operating cash flow (null on US rows). */
  operatingCashFlow: number | null;
}

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Absolute amount → scaled, fixed 2 decimals: 751766000000 → "751.77B". */
export function scaledMoney(x: number): string {
  const a = Math.abs(x);
  if (a >= 1e9) return `${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(x / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(x / 1e3).toFixed(2)}K`;
  return x.toFixed(2);
}

/** Percent-unit value → signed 1-decimal percent: 13.8596 → "+13.9%". */
export function signedPct(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
}

const field = (label: string, v: number | null, fmt: (x: number) => string): string =>
  `${label}: ${v === null ? "n/a" : fmt(v)}`;

function renderPeriod(row: F10IndicatorRow): string[] {
  const lines = [
    `${row.reportType} (${row.reportDate}, ${row.currency || "currency n/a"})`,
    `  ${field("revenue", row.revenue, scaledMoney)}${row.revenueYoy === null ? "" : ` (yoy ${signedPct(row.revenueYoy)})`}`,
    `  ${field("net profit", row.netProfit, scaledMoney)}${row.netProfitYoy === null ? "" : ` (yoy ${signedPct(row.netProfitYoy)})`}`,
    `  ${field("gross margin", row.grossMargin, signedPct).replace("+", "")}, ${field("net margin", row.netMargin, signedPct).replace("+", "")}`,
    `  ${field("ROE(avg)", row.roe, signedPct).replace("+", "")}, ${field("debt/assets", row.debtRatio, signedPct).replace("+", "")}, ${field("EPS", row.eps, (x) => x.toFixed(2))}`,
  ];
  if (row.operatingCashFlow !== null) lines.push(`  operating cash flow: ${scaledMoney(row.operatingCashFlow)}`);
  return lines;
}

/** Pure shaping: rows sorted REPORT_DATE desc → latest annual + latest
 *  interim/quarter text block. Deterministic (fixed precision everywhere). */
export function renderFundamentalsSnapshot(rows: F10IndicatorRow[]): string | null {
  if (!rows.length) return null;
  const annual = rows.find((r) => r.dateTypeCode === "001");
  const interim = rows.find((r) => r.dateTypeCode !== "001");
  const lines: string[] = [];
  if (interim) lines.push(...renderPeriod(interim));
  if (annual && annual !== interim) lines.push(...renderPeriod(annual));
  return lines.length ? lines.join("\n") : null;
}

export class EastmoneyF10Provider implements F10Provider {  private readonly spacingMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastRequestAt = 0;

  constructor(opts: EastmoneyF10ProviderOptions = {}) {
    this.spacingMs = opts.spacingMs ?? 1_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
  }

  /** Sequential pacing (measured-clean host, but keep ban discipline). */
  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt === 0 ? 0 : this.lastRequestAt + jitter(this.spacingMs) - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async fetchDividendRows(symbol: string): Promise<{ rows: F10DividendRow[] } | { failure: string }> {
    // F10 wants the bare 5-digit code ("00700"); derive from the secid.
    const { eastmoneySecid } = hkSymbolMaps(symbol); // throws on non-HK — programming error
    const code = eastmoneySecid.slice("116.".length);
    await this.throttle();
    const url =
      `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_HKF10_MAIN_DIVBASIC` +
      `&columns=SECURITY_CODE,UPDATE_DATE,NOTICE_DATE,REPORT_TYPE,EX_DIVIDEND_DATE,DIVIDEND_DATE,TRANSFER_END_DATE,YEAR,PLAN_EXPLAIN,IS_BFP` +
      `&filter=(SECURITY_CODE="${code}")(IS_BFP="0")&pageNumber=1&pageSize=200&sortTypes=-1,-1&sortColumns=NOTICE_DATE,EX_DIVIDEND_DATE` +
      `&source=F10&client=PC`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), F10_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, { headers: { "User-Agent": UA }, signal: ac.signal });
      if (res.status !== 200) return { failure: `http-${res.status}` };
      const json = (await res.json()) as any;
      if (typeof json !== "object" || json === null) return { failure: "malformed-json" };
      // result:null = no report for the name (ETFs — measured 2800.HK);
      // result.data:[] = real stock with no dividends (measured 01810).
      // Both are legitimate absence, never a failure.
      if (json.result === null || json.result === undefined) return { rows: [] };
      const data: unknown = json.result.data;
      if (!Array.isArray(data)) return { failure: "http-200-wrong-shape" };
      const rows: F10DividendRow[] = data.map((r: any) => ({
        noticeDate: normalizeF10Date(r?.NOTICE_DATE),
        exDate: normalizeF10Date(r?.EX_DIVIDEND_DATE),
        payDate: normalizeF10Date(r?.DIVIDEND_DATE),
        reportType: typeof r?.REPORT_TYPE === "string" ? r.REPORT_TYPE : "",
        plan: typeof r?.PLAN_EXPLAIN === "string" ? r.PLAN_EXPLAIN : "",
      }));
      return { rows };
    } catch (err: any) {
      if (err?.name === "AbortError") return { failure: "timeout" };
      const detail = String(err?.cause?.code ?? err?.cause?.message ?? err?.message ?? err);
      return { failure: `transport:${detail}`.slice(0, 160) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Shared GET against datacenter.eastmoney.com, paced + failure-as-value. */
  private async f10Get(params: string): Promise<{ data: any[] } | { failure: string }> {
    await this.throttle();
    const url = `https://datacenter.eastmoney.com/securities/api/data/v1/get?${params}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), F10_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, { headers: { "User-Agent": UA }, signal: ac.signal });
      if (res.status !== 200) return { failure: `http-${res.status}` };
      const json = (await res.json()) as any;
      if (typeof json !== "object" || json === null) return { failure: "malformed-json" };
      // result:null = no report for the name (ETFs) — legitimate absence.
      if (json.result === null || json.result === undefined) return { data: [] };
      if (!Array.isArray(json.result.data)) return { failure: "http-200-wrong-shape" };
      return { data: json.result.data };
    } catch (err: any) {
      if (err?.name === "AbortError") return { failure: "timeout" };
      const detail = String(err?.cause?.code ?? err?.cause?.message ?? err?.message ?? err);
      return { failure: `transport:${detail}`.slice(0, 160) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** US names need a SECUCODE ("TSLA.O") before the indicator table can be
   *  queried (akshare idiom). Cached per symbol — it's static metadata. */
  private usSecucodeCache = new Map<string, string>();

  private async usSecucode(symbol: string): Promise<{ secucode: string } | { failure: string }> {
    const cached = this.usSecucodeCache.get(symbol);
    if (cached) return { secucode: cached };
    const res = await this.f10Get(
      `reportName=RPT_USF10_INFO_ORGPROFILE&columns=SECUCODE,SECURITY_CODE&filter=(SECURITY_CODE="${symbol}")&pageNumber=1&pageSize=10&source=SECURITIES&client=PC`,
    );
    if ("failure" in res) return res;
    const secucode = res.data.find((r) => str(r?.SECURITY_CODE) === symbol)?.SECUCODE ?? res.data[0]?.SECUCODE;
    if (typeof secucode !== "string" || !secucode) return { failure: "no-secucode" };
    this.usSecucodeCache.set(symbol, secucode);
    return { secucode };
  }

  /** Compact fundamentals snapshot for the deep-dive prompt (stocks only —
   *  ETFs get { text: null }; callers skip ETFs entirely). Returns
   *  { text: null } on legitimate absence, { failure } on fetch problems. */
  async fetchFundamentalsSnapshot(symbol: string): Promise<{ text: string | null } | { failure: string }> {
    let res: { data: any[] } | { failure: string };
    const isHk = /^\d{4}\.HK$/.test(symbol);
    if (isHk) {
      const { eastmoneySecid } = hkSymbolMaps(symbol); // throws on malformed — programming error
      const code = eastmoneySecid.slice("116.".length);
      res = await this.f10Get(
        `reportName=RPT_HKF10_FN_MAININDICATOR&columns=SECUCODE,SECURITY_CODE,REPORT_DATE,DATE_TYPE_CODE,REPORT_TYPE,CURRENCY,` +
          `OPERATE_INCOME,OPERATE_INCOME_YOY,HOLDER_PROFIT,HOLDER_PROFIT_YOY,GROSS_PROFIT_RATIO,NET_PROFIT_RATIO,ROE_AVG,DEBT_ASSET_RATIO,BASIC_EPS,NETCASH_OPERATE` +
          `&filter=(SECURITY_CODE="${code}")&pageNumber=1&pageSize=12&sortTypes=-1&sortColumns=REPORT_DATE&source=F10&client=PC`,
      );
    } else {
      const sec = await this.usSecucode(symbol);
      if ("failure" in sec) return { failure: `orgprofile-${sec.failure}` };
      res = await this.f10Get(
        `reportName=RPT_USF10_FN_GMAININDICATOR&columns=SECUCODE,SECURITY_CODE,REPORT_DATE,DATE_TYPE_CODE,REPORT_TYPE,CURRENCY,` +
          `OPERATE_INCOME,OPERATE_INCOME_YOY,PARENT_HOLDER_NETPROFIT,PARENT_HOLDER_NETPROFIT_YOY,GROSS_PROFIT_RATIO,NET_PROFIT_RATIO,ROE_AVG,DEBT_ASSET_RATIO,BASIC_EPS` +
          `&filter=(SECUCODE="${sec.secucode}")&pageNumber=1&pageSize=12&sortTypes=-1&sortColumns=REPORT_DATE&source=SECURITIES&client=PC`,
      );
    }
    if ("failure" in res) return res;
    const rows: F10IndicatorRow[] = res.data.map((r: any) => ({
      reportDate: str(r?.REPORT_DATE).slice(0, 10),
      dateTypeCode: str(r?.DATE_TYPE_CODE),
      reportType: str(r?.REPORT_TYPE),
      currency: str(r?.CURRENCY),
      revenue: numOrNull(r?.OPERATE_INCOME),
      revenueYoy: numOrNull(r?.OPERATE_INCOME_YOY),
      netProfit: numOrNull(isHk ? r?.HOLDER_PROFIT : r?.PARENT_HOLDER_NETPROFIT),
      netProfitYoy: numOrNull(isHk ? r?.HOLDER_PROFIT_YOY : r?.PARENT_HOLDER_NETPROFIT_YOY),
      grossMargin: numOrNull(r?.GROSS_PROFIT_RATIO),
      netMargin: numOrNull(r?.NET_PROFIT_RATIO),
      roe: numOrNull(r?.ROE_AVG),
      debtRatio: numOrNull(r?.DEBT_ASSET_RATIO),
      eps: numOrNull(r?.BASIC_EPS),
      operatingCashFlow: isHk ? numOrNull(r?.NETCASH_OPERATE) : null,
    }));
    return { text: renderFundamentalsSnapshot(rows) };
  }
}
