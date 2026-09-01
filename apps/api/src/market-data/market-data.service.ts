/**
 * MarketDataService — the thinnest possible consumer of the provider seam:
 * classifies the raw response into DataOutcome (quant-core RULE L3/L4) and,
 * on OK, applies the loader repair rules (L1 holiday-phantom drop for HK
 * names, L2 close-outside-[H,L] clamp) plus the CA_DEGRADED flag for
 * FX-inconsistent HK dividend events (architecture §4, 9988.HK case).
 */
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import {
  clampOhlc,
  classifyResponse,
  DataOutcome,
  dropHolidayPhantomBars,
  HKEX_HOLIDAYS,
  NYSE_HOLIDAYS,
  type Bar,
  type CorporateAction,
} from "@agentic-trading/quant-core";
import { MARKET_DATA_DEPS, type MarketDataDeps } from "./market-data.deps.js";
import type { FetchWindow } from "./market-data.types.js";

/** @deprecated Use quant-core's HKEX_HOLIDAYS / NYSE_HOLIDAYS. Kept for
 *  backwards compatibility with existing imports. */
export const HKEX_KNOWN_HOLIDAYS: ReadonlySet<string> = HKEX_HOLIDAYS;

export interface DailyBarsResult {
  symbol: string;
  outcome: DataOutcome;
  /** Populated only on OK; empty otherwise. */
  bars: Bar[];
  corporateActions: CorporateAction[];
  /** Provider diagnostic on non-OK outcomes (e.g. "http-429", "timeout"). */
  failureReason?: string;
  /** Dates dropped by RULE L1 (HKEX-holiday phantom bars). */
  droppedPhantomBars: string[];
  /** Dates repaired by RULE L2 (close clamped into [H,L]). */
  repairedBars: string[];
  /** True on an HK name whose dividend events look FX-converted by Yahoo
   *  (USD-declaring payers: 0005.HK, 9988.HK, 2888.HK) — amounts unusable
   *  for local adjustment. Detection (measured live 2026-09-01): the bug's
   *  fingerprint is >4-decimal amounts under an HKD meta label (e.g.
   *  0.783188, 6–8dp); the `currency` field always echoes meta.currency, so
   *  a currency mismatch can never fire. Either signal flags it. */
  caDegraded: boolean;
  /** Split events observed in the window (audit count only — never stored,
   *  never applied; R1). */
  splitCount: number;
}

@Injectable()
export class MarketDataService {
  constructor(@Inject(MARKET_DATA_DEPS) private readonly deps: MarketDataDeps) {}

  async getDailyBars(symbol: string, opts?: FetchWindow): Promise<DailyBarsResult> {
    if (!symbol) throw new BadRequestException("symbol is required");
    const raw = await this.deps.provider.fetchDailyBars(symbol, opts);
    const outcome = classifyResponse({
      httpStatus: raw.httpStatus,
      hasTimestamps: raw.hasTimestamps,
      barCount: raw.bars.length,
      providerSaysNotFound: raw.providerSaysNotFound,
    });
    if (outcome !== DataOutcome.OK) {
      return {
        symbol,
        outcome,
        bars: [],
        corporateActions: [],
        failureReason: raw.failureReason,
        droppedPhantomBars: [],
        repairedBars: [],
        caDegraded: false,
        splitCount: raw.splitCount ?? 0,
      };
    }

    const isHK = symbol.endsWith(".HK");
    const beforeL1 = raw.bars;
    // RULE L1 with the matching exchange calendar (phase-1-spec §2).
    const barsAfterL1 = dropHolidayPhantomBars(beforeL1, isHK ? HKEX_HOLIDAYS : NYSE_HOLIDAYS);
    const droppedPhantomBars = beforeL1.filter((b) => !barsAfterL1.includes(b)).map((b) => b.date);
    const { bars, repaired } = clampOhlc(barsAfterL1);
    // CA_DEGRADED (phase-1-spec §2, amended 2026-09-01): the Yahoo FX bug's
    // fingerprint is >4-decimal dividend amounts — the event `currency` field
    // just echoes meta.currency (HKD), so a mismatch can never fire. Both
    // signals checked; either flags it.
    const decimals = (x: number): number => {
      const s = String(x);
      const i = s.indexOf(".");
      return i < 0 ? 0 : s.length - i - 1;
    };
    const caDegraded =
      isHK &&
      raw.corporateActions.some((ca) => ca.type === "DIVIDEND" && (ca.currency !== "HKD" || decimals(ca.amount) > 4));

    return {
      symbol,
      outcome,
      bars,
      corporateActions: raw.corporateActions,
      droppedPhantomBars,
      repairedBars: repaired,
      caDegraded,
      splitCount: raw.splitCount ?? 0,
    };
  }
}
