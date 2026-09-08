import { Controller, Get, Param, Query } from "@nestjs/common";
import { parseRunIdParam, ReportsService, type DailyReport, type DeepDiveTranscript } from "./reports.service.js";

/** Read-only report endpoints (phase-3-plan §3a). No provider/LLM calls. */
@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** GET /reports/daily?market=US|HK[&runId=N] — deep-dive run joined to its
   *  screen run: integrity header + ranked rows with verdict overlay. runId
   *  omitted → latest run for the market. */
  @Get("daily")
  async daily(@Query("market") market?: string, @Query("runId") runId?: string): Promise<DailyReport> {
    return this.reports.daily(market ?? "", runId === undefined ? undefined : parseRunIdParam(runId));
  }

  /** GET /reports/deep-dive/:runId/:symbol — full verdict + ordered
   *  AgentDecision transcript (pipeline order from decisionHashesJson). */
  @Get("deep-dive/:runId/:symbol")
  async deepDive(@Param("runId") runId: string, @Param("symbol") symbol: string): Promise<DeepDiveTranscript> {
    return this.reports.deepDive(parseRunIdParam(runId), symbol);
  }
}
