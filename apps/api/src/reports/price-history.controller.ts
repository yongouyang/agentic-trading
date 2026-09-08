import { Controller, Get, Param, Query } from "@nestjs/common";
import { parseDaysParam, ReportsService, type PriceHistory } from "./reports.service.js";

/** Store-only read controller for /instruments — deliberately separate from
 *  MarketDataController, which is the live-fetch provider seam
 *  (/instruments/:symbol/bars). This controller NEVER fetches. */
@Controller("instruments")
export class PriceHistoryController {
  constructor(private readonly reports: ReportsService) {}

  /** GET /instruments/:symbol/price-history?days=250 — adjusted close series
   *  (deriveAdjustedBars, same convention as the screen) + CA markers. */
  @Get(":symbol/price-history")
  async priceHistory(@Param("symbol") symbol: string, @Query("days") days?: string): Promise<PriceHistory> {
    return this.reports.priceHistory(symbol, parseDaysParam(days));
  }
}
