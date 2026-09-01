import { BadRequestException, Controller, Get, Headers, Inject, Param } from "@nestjs/common";
import { MARKET_DATA_DEPS, type MarketDataDeps } from "./market-data.deps.js";
import { MarketDataService, type DailyBarsResult } from "./market-data.service.js";
import { DUMMY_BEHAVIORS, type DummyBehavior } from "./market-data.types.js";
import type { DummyMarketDataProvider } from "./dummy-market-data.provider.js";

@Controller("instruments")
export class MarketDataController {
  constructor(
    private readonly marketData: MarketDataService,
    @Inject(MARKET_DATA_DEPS) private readonly deps: MarketDataDeps,
  ) {}

  /** GET /instruments/:symbol/bars — daily bars through the provider seam,
   *  data-quality typing applied via quant-core. */
  @Get(":symbol/bars")
  async bars(
    @Param("symbol") symbol: string,
    @Headers("x-test-market-behavior") behavior?: string,
  ): Promise<DailyBarsResult> {
    // Test-mode injection (the _testResponse precedent): honored ONLY when
    // MARKET_DATA_TEST_MODE=1 AND the active provider is the dummy — never
    // with a real provider, and the dummy itself is refused in production
    // (see market-data.deps.ts).
    if (behavior !== undefined) {
      if (this.deps.testMode && this.deps.dummyMode) {
        if (!DUMMY_BEHAVIORS.includes(behavior as DummyBehavior)) {
          throw new BadRequestException(`unknown test behavior "${behavior}" (expected one of ${DUMMY_BEHAVIORS.join(", ")})`);
        }
        (this.deps.provider as DummyMarketDataProvider).setBehavior(symbol, behavior as DummyBehavior);
      }
      // Outside test mode the header is ignored — a leaked header must never
      // change real-provider behavior.
    }
    return this.marketData.getDailyBars(symbol);
  }
}
