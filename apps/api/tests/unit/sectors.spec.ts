/**
 * Phase 7 P2 — sector bucketing known-answer tests (docs/phase-7-plan.md §E3).
 */
import { describe, expect, it } from "vitest";
import { sectorFromEastmoneyIndustry, sectorFromSic, SECTOR_BUCKETS } from "../../src/fundamentals/sectors.js";

describe("sectorFromSic", () => {
  it("maps known SIC codes to buckets", () => {
    expect(sectorFromSic("3571")).toBe("Technology"); // Apple — electronic computers
    expect(sectorFromSic("7372")).toBe("Technology"); // software (4-digit override)
    expect(sectorFromSic("3674")).toBe("Technology"); // semiconductors
    expect(sectorFromSic("2834")).toBe("Healthcare"); // pharma (override)
    expect(sectorFromSic("6021")).toBe("Financials"); // national commercial banks
    expect(sectorFromSic("1311")).toBe("Energy"); // crude petroleum & natural gas
    expect(sectorFromSic("4911")).toBe("Utilities"); // electric services
    expect(sectorFromSic("4833")).toBe("Communication Services"); // TV broadcasting
    expect(sectorFromSic("5961")).toBe("Consumer Discretionary"); // e-commerce retail
    expect(sectorFromSic("6512")).toBe("Real Estate");
    expect(sectorFromSic("2086")).toBe("Consumer Staples"); // beverages
  });

  it("falls back to Other for missing/unknown codes", () => {
    expect(sectorFromSic(null)).toBe("Other");
    expect(sectorFromSic("")).toBe("Other");
    expect(sectorFromSic("9999")).toBe("Other");
  });
});

describe("sectorFromEastmoneyIndustry", () => {
  it("maps known Chinese industry labels to buckets", () => {
    expect(sectorFromEastmoneyIndustry("软件服务")).toBe("Technology"); // Tencent
    expect(sectorFromEastmoneyIndustry("银行")).toBe("Financials");
    expect(sectorFromEastmoneyIndustry("保险")).toBe("Financials");
    expect(sectorFromEastmoneyIndustry("地产")).toBe("Real Estate");
    expect(sectorFromEastmoneyIndustry("医疗保健")).toBe("Healthcare");
    expect(sectorFromEastmoneyIndustry("石油")).toBe("Energy");
    expect(sectorFromEastmoneyIndustry("电力")).toBe("Utilities");
    expect(sectorFromEastmoneyIndustry("汽车")).toBe("Consumer Discretionary");
    expect(sectorFromEastmoneyIndustry("食品饮料")).toBe("Consumer Staples");
  });

  it("falls back to Other for empty or unknown labels", () => {
    expect(sectorFromEastmoneyIndustry(null)).toBe("Other");
    expect(sectorFromEastmoneyIndustry("")).toBe("Other");
    expect(sectorFromEastmoneyIndustry("某某未知行业")).toBe("Other");
  });
});

it("bucket list is stable (subgroup freeze depends on it)", () => {
  expect([...SECTOR_BUCKETS]).toEqual([
    "Technology",
    "Communication Services",
    "Consumer Discretionary",
    "Consumer Staples",
    "Healthcare",
    "Financials",
    "Industrials",
    "Energy",
    "Materials",
    "Utilities",
    "Real Estate",
    "Other",
  ]);
});
