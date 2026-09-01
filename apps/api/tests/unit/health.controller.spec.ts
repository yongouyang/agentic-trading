import { describe, expect, it, vi } from "vitest";
import { HealthController } from "../../src/health.controller.js";
import type { PrismaService } from "../../src/prisma.service.js";

describe("HealthController", () => {
  it("reports ok with the instrument count from the database", async () => {
    const prisma = { instrument: { count: vi.fn().mockResolvedValue(7) } } as unknown as PrismaService;
    const controller = new HealthController(prisma);
    await expect(controller.check()).resolves.toEqual({ status: "ok", instruments: 7 });
    expect(prisma.instrument.count).toHaveBeenCalledOnce();
  });

  it("propagates database failures (typed and loud, never silent)", async () => {
    const prisma = { instrument: { count: vi.fn().mockRejectedValue(new Error("db down")) } } as unknown as PrismaService;
    const controller = new HealthController(prisma);
    await expect(controller.check()).rejects.toThrow("db down");
  });
});
