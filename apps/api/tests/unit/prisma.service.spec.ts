import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../../src/prisma.service.js";
import { createTestDatabase, destroyTestDatabase, type TestDatabase } from "../helpers/test-db.js";

describe("PrismaService wiring", () => {
  let db: TestDatabase;
  let prisma: PrismaService;

  beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    prisma = new PrismaService();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    delete process.env.DATABASE_URL;
    destroyTestDatabase(db);
  });

  it("connects to a throwaway SQLite db with the real schema applied", async () => {
    await expect(prisma.instrument.count()).resolves.toBe(0);
  });

  it("round-trips an instrument with bars and a dividend event", async () => {
    const instrument = await prisma.instrument.create({
      data: {
        symbol: "0005.HK",
        market: "HK",
        currency: "HKD",
        bars: { create: [{ date: "2024-12-31", open: 75, high: 76, low: 74, close: 75.5, volume: 1_000_000 }] },
        corporateActions: { create: [{ date: "2024-06-13", type: "DIVIDEND", amount: 0.31, currency: "HKD" }] },
      },
      include: { bars: true, corporateActions: true },
    });
    expect(instrument.bars).toHaveLength(1);
    expect(instrument.corporateActions[0]?.type).toBe("DIVIDEND");
    expect(instrument.caDegraded).toBe(false);

    const found = await prisma.instrument.findUnique({ where: { symbol: "0005.HK" } });
    expect(found?.market).toBe("HK");
  });
});
