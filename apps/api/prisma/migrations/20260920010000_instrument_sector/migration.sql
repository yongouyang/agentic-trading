-- Phase 7 P2 (docs/phase-7-plan.md §E3, 2026-09-20): static sector label per
-- stored name. US: coarse bucket mapped from the EDGAR SIC code (submissions
-- API). HK: coarse bucket mapped from eastmoney's BELONG_INDUSTRY (F10
-- orgprofile). Grouping attribute only — no PIT concern.
ALTER TABLE "Instrument" ADD COLUMN "sector" TEXT;
