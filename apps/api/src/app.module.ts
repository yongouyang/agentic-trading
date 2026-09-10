import { Module } from "@nestjs/common";
import { ChatModule } from "./chat/chat.module.js";
import { HealthController } from "./health.controller.js";
import { MarketDataModule } from "./market-data/market-data.module.js";
import { OpsModule } from "./ops/ops.module.js";
import { PrismaService } from "./prisma.service.js";
import { ReportsModule } from "./reports/reports.module.js";

@Module({
  imports: [MarketDataModule, ReportsModule, ChatModule, OpsModule],
  controllers: [HealthController],
  providers: [PrismaService],
})
export class AppModule {}
