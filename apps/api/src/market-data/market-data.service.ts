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
  type Bar,
  type CorporateAction,
} from "@agentic-trading/quant-core";
import { MARKET_DATA_DEPS, type MarketDataDeps } from "./market-data.deps.js";

/** Known HKEX holidays with measured Yahoo phantom bars (verification report). */
export const HKEX_KNOWN_HOLIDAYS: ReadonlySet<string> = new Set(["2022-01-31", "2023-09-08"]);

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
  /** True when dividend event currency ≠ instrument currency on an HK name —
   *  Yahoo FX-inconsistent amounts (9988.HK), unusable for local adjustment. */
  caDegraded: boolean;
}

@Injectable()
export class MarketDataService {
  constructor(@Inject(MARKET_DATA_DEPS) private readonly deps: MarketDataDeps) {}

  async getDailyBars(symbol: string): Promise<DailyBarsResult> {
    if (!symbol) throw new BadRequestException("symbol is required");
    const raw = await this.deps.provider.fetchDailyBars(symbol);
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
      };
    }

    const isHK = symbol.endsWith(".HK");
    const beforeL1 = raw.bars;
    const barsAfterL1 = isHK ? dropHolidayPhantomBars(beforeL1, HKEX_KNOWN_HOLIDAYS) : beforeL1;
    const droppedPhantomBars = beforeL1.filter((b) => !barsAfterL1.includes(b)).map((b) => b.date);
    const { bars, repaired } = clampOhlc(barsAfterL1);
    const caDegraded = isHK && raw.corporateActions.some((ca) => ca.currency !== "HKD");

    return {
      symbol,
      outcome,
      bars,
      corporateActions: raw.corporateActions,
      droppedPhantomBars,
      repairedBars: repaired,
      caDegraded,
    };
  }
}
