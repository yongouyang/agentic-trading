-- ScreenRun.source: 'chain' (screen:daily — scheduled or manual, the same
-- deterministic screen of the newest session) or 'rescreen' (screen:rescreen,
-- a point-in-time recompute of a session missed during a multi-day outage —
-- architecture §5.1 recovery semantics).
--
-- Backfill: every existing row defaulted to 'chain' — every one came from
-- screen:daily. The column exists to mark rescreen rows, whose fresh runAt and
-- OLD sessionDate must never make a lane read as behind (ops:catchup) or as
-- the newest session (ops:health): both order by sessionDate, not runAt.
ALTER TABLE "ScreenRun" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'chain';
