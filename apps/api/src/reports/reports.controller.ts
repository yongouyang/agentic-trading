import { Controller, Get, Param, Query } from "@nestjs/common";
import { parseRunsLimitParam, parseRunIdParam, ReportsService, type DailyReport, type DeepDiveTranscript, type RunSummary } from "./reports.service.js";

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

  /** GET /reports/runs?market=&limit=&symbol= — DeepDiveRun summaries, newest
   *  first (phase-3c). market optional (US|HK); limit default 20 clamped to
   *  [1, 50]; symbol optional — only runs with a DeepDiveReport for it. */
  @Get("runs")
  async runs(@Query("market") market?: string, @Query("limit") limit?: string, @Query("symbol") symbol?: string): Promise<RunSummary[]> {
    return this.reports.listRuns(market, parseRunsLimitParam(limit), symbol);
  }
}
