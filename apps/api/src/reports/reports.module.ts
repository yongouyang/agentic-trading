import { Module } from "@nestjs/common";
import { PrismaService } from "../prisma.service.js";
import { PriceHistoryController } from "./price-history.controller.js";
import { ReportsController } from "./reports.controller.js";
import { ReportsService } from "./reports.service.js";

@Module({
  controllers: [ReportsController, PriceHistoryController],
  providers: [ReportsService, PrismaService],
  exports: [ReportsService], // chat tools call it in-process (phase-3b)
})
export class ReportsModule {}
