import { Module } from "@nestjs/common";
import { OpsController } from "./ops.controller.js";
import { PrismaService } from "../prisma.service.js";

@Module({
  controllers: [OpsController],
  providers: [PrismaService],
})
export class OpsModule {}
