import { Controller, Get } from "@nestjs/common";
import { computeHealth, type HealthReport } from "../ops/health.js";
import { PrismaService } from "../prisma.service.js";

/**
 * GET /ops/health (W4c, docs/ops-hardening-plan.md) — read-only pipeline
 * health for the dashboard banner.
 *
 * Unlike /reports/daily this succeeds even when NO run exists: an unhealthy
 * pipeline is a normal, expected answer here, not a 404. It deliberately does
 * NOT swallow a database failure into a fake 200 — that would report "no runs
 * on record" when the real problem is that the store is unreachable, which is
 * the more dangerous lie. A DB error becomes a 500 and the web's never-throw
 * fetcher renders "health: unreachable" instead.
 */
@Controller("ops")
export class OpsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("health")
  async health(): Promise<HealthReport> {
    return computeHealth(this.prisma);
  }
}
