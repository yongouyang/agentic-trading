import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { MarketDataModule } from "./market-data/market-data.module.js";
import { PrismaService } from "./prisma.service.js";

@Module({
  imports: [MarketDataModule],
  controllers: [HealthController],
  providers: [PrismaService],
})
export class AppModule {}
