-- W2 (docs/ops-hardening-plan.md): a DeepDiveRun row is created BEFORE the
-- lane's name pool and flipped to 'complete' only after its DeepDiveReport rows
-- are written. A crashed or killed run therefore leaves a detectable 'running'
-- row instead of nothing. Measured 2026-09-10: the US leg made 40 live calls,
-- completed 4 of 10 verdicts, was killed at 08:37:43, and discarded all of it
-- invisibly — no DeepDiveRun row existed to show a run had even started.
--
-- Additive with an explicit 'complete' default: every pre-existing row is a
-- finished run by definition, so this backfills them and needs no data step.
ALTER TABLE "DeepDiveRun" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'complete';
