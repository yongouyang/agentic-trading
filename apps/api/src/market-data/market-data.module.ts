import { Module } from "@nestjs/common";
import { MARKET_DATA_DEPS, getMarketDataDeps } from "./market-data.deps.js";
import { MarketDataController } from "./market-data.controller.js";
import { MarketDataService } from "./market-data.service.js";

@Module({
  controllers: [MarketDataController],
  providers: [MarketDataService, { provide: MARKET_DATA_DEPS, useFactory: () => getMarketDataDeps() }],
})
export class MarketDataModule {}
