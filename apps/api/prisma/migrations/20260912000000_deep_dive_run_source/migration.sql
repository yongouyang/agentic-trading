-- DeepDiveRun.source: 'chain' (the scheduled pipeline) or 'adhoc' (an operator
-- run: --symbol, an explicit --top, or --as-of).
--
-- Why it exists: the dashboard shows the newest COMPLETE run per lane, so an
-- ad-hoc run silently becomes the lane's view. Measured 2026-09-12: HK's
-- dashboard showed run 8 — a 3-name smoke test — as the lane's latest, rendering 5
-- rows from a legacy 15-candidate list of which only 3 had verdicts, while the
-- newer 27-candidate list was invisible. The same hazard applies to the Phase-5
-- prompt-experiment worktree, whose entire purpose is to run without becoming
-- production.
--
-- Backfill: the scheduled chain has NEVER passed --top (it uses the CLI default),
-- and every chain-era run deep-dived >= 10 names, so any run below 10 is an
-- operator smoke. Recorded as an inference, not presented as fact.
ALTER TABLE "DeepDiveRun" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'chain';
UPDATE "DeepDiveRun" SET "source" = 'adhoc' WHERE "topN" < 10;
