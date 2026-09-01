/**
 * Pinned weekly-sentinel sample (phase-1-hardening-plan §B, decision 3:
 * "sentinel is a manual CLI with a fixed 10-name HK sample"). DO NOT edit
 * casually: the JSON artifacts are the diff baseline for future runs, and the
 * set is deliberately mixed so a provider convention change cannot hide —
 * CA-heavy HKD payers (0005, 0388, 0941, 2318), USD-declaring CA_DEGRADED
 * payers (9988), a plain ETF (2800), and an HK-domiciled US-index tracker
 * (3195, which also exercises tencent's `day`-instead-of-`qfqday` shape).
 * Unit-tested against the plan text so a silent edit fails CI.
 */
export const SENTINEL_HK_SAMPLE: readonly string[] = [
  "0005.HK", // HSBC — HKD-native payer, FX-bug history (0005.HK had 16/17 consistent events)
  "0700.HK", // Tencent — HK's largest cap, >20% day in sample
  "0941.HK", // China Mobile — high-yield, many dividends
  "9988.HK", // Alibaba — USD-declaring (CA_DEGRADED, Yahoo FX bug)
  "0388.HK", // HKEX — steady payer, long history
  "0001.HK", // CK Hutchison — diversified payer
  "0016.HK", // Sun Hung Kai — property cycle, dividends
  "2318.HK", // Ping An — insurance, HKD+CNY dividends
  "2800.HK", // Tracker Fund of Hong Kong — 10 HKD-native dividend events, G2d exact-match baseline
  "3195.HK", // Hang Seng S&P 500 ETF — HK-domiciled US tracker, tencent `day` series
];
