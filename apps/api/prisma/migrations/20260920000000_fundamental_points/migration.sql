-- Phase 7 (docs/phase-7-plan.md §2, 2026-09-20): PIT fundamental points.
-- Restatements coexist as separate filings of the same period — the PIT read
-- is "latest point with filedAt <= T". HK rows carry a SYNTHETIC anchor
-- (periodEnd + 90d, filedAtSynthetic=1): eastmoney exposes no announcement
-- date (probe E2a, 2026-09-20).
CREATE TABLE "FundamentalPoint" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "periodEnd" TEXT NOT NULL,
    "periodType" TEXT NOT NULL,
    "filedAt" TEXT NOT NULL,
    "filedAtSynthetic" BOOLEAN NOT NULL DEFAULT false,
    "value" DOUBLE PRECISION NOT NULL,
    "currency" TEXT,
    "accession" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "FundamentalPoint_symbol_source_metric_periodEnd_periodType_filedAt_key" ON "FundamentalPoint"("symbol", "source", "metric", "periodEnd", "periodType", "filedAt");
CREATE INDEX "FundamentalPoint_market_metric_idx" ON "FundamentalPoint"("market", "metric");
