/**
 * Market-data provider seam (Day-17 Reader/Loader design, architecture §4).
 * The provider delivers the RAW response shape; classification into
 * DataOutcome and loader repair rules (L1–L4) live in quant-core and are
 * applied by MarketDataService — providers never pre-judge outcomes.
 */
import type { Bar, CorporateAction } from "@agentic-trading/quant-core";

/** Injectable dummy behaviors — one per measured failure/edge case in
 *  docs/phase-0-verification-report.md:
 *  - "rate-limited"              HTTP 429 (G5 taxonomy probe)
 *  - "timeout"                   transport failure, no HTTP status (G5)
 *  - "empty-bars"                HTTP 200 + empty bar array (tencent hk0005, RULE L4)
 *  - "zombie-meta"               HTTP 200, no timestamps (defunct RYL meta, RULE L3)
 *  - "not-found"                 "No data found" (NOSUCHTICKER / TWTR → GENUINELY_ABSENT)
 *  - "fx-inconsistent-dividends" USD-declared dividends on an HK name (9988.HK)
 *  - "holiday-phantom"           zero-volume bar on an HKEX holiday (2022-01-31, RULE L1)
 *  - "close-outside-hl"          close outside [H,L] (LSE UCITS / HK edge names, RULE L2) */
export type DummyBehavior =
  | "ok"
  | "rate-limited"
  | "timeout"
  | "empty-bars"
  | "zombie-meta"
  | "not-found"
  | "fx-inconsistent-dividends"
  | "holiday-phantom"
  | "close-outside-hl";

export const DUMMY_BEHAVIORS: readonly DummyBehavior[] = [
  "ok",
  "rate-limited",
  "timeout",
  "empty-bars",
  "zombie-meta",
  "not-found",
  "fx-inconsistent-dividends",
  "holiday-phantom",
  "close-outside-hl",
];

/** Raw provider response, pre-classification — the loader's input shape.
 *  Mirrors quant-core's RawResponseShape plus the payloads. */
export interface RawMarketDataResponse {
  /** HTTP status, or null for transport failure (timeout / dropped conn). */
  httpStatus: number | null;
  /** True when the payload parses and carries a bar/timestamp array. */
  hasTimestamps: boolean;
  bars: Bar[];
  corporateActions: CorporateAction[];
  /** Provider error body matched "No data found" / 404 semantics. */
  providerSaysNotFound: boolean;
  /** Diagnostic only (e.g. "http-429"); never drives classification. */
  failureReason?: string;
}

export interface MarketDataProvider {
  fetchDailyBars(symbol: string): Promise<RawMarketDataResponse>;
}
