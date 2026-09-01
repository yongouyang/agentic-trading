/**
 * HK symbol mapping (phase-1-hardening-plan §A.1) — pure function.
 * Yahoo `0005.HK` (4-digit) → eastmoney `00005` (secid `116.00005`) →
 * tencent `hk00005`. Non-`.HK` symbols and wrong digit counts are programming
 * errors and throw loudly (never a provider failure).
 */

export interface HkSymbolMaps {
  /** eastmoney push2his secid, e.g. "116.00005". */
  eastmoneySecid: string;
  /** tencent ifzq code, e.g. "hk00005". */
  tencentCode: string;
}

export function hkSymbolMaps(symbol: string): HkSymbolMaps {
  const m = /^(\d{4})\.HK$/.exec(symbol);
  if (!m) {
    throw new Error(`[hk-symbol-map] "${symbol}" is not a Yahoo HK symbol (expected 4 digits + ".HK")`);
  }
  const five = `0${m[1]}`;
  return { eastmoneySecid: `116.${five}`, tencentCode: `hk${five}` };
}
