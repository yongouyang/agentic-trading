import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "./prisma.service.js";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    const instruments = await this.prisma.instrument.count();
    return { status: "ok", instruments };
  }
}
