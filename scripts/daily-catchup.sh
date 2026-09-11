#!/usr/bin/env bash
# Evening catch-up (2026-09-11). launchd does not replay calendar slots missed
# across POWER-OFF (only sleep — architecture §5.1), and measured supply is 56 %:
# 5 of 9 expected slots per lane since 2026-09-01. That now costs a lost
# OBSERVATION from two validation samples (Phase 5's verdict IC and Phase 4c's
# screen rank IC), not merely a stale report — it roughly doubles the longer clock.
#
# Guarded: ops:catchup decides per lane whether the store holds a session no run
# has screened, so this is a no-op on a day the normal slot fired. Exit 10 from the
# guard means "run it", 0 means "up to date", anything else means the guard itself
# failed and we do NOT run (a blind run would duplicate a session and inflate the
# very sample this protects).
#
# Scheduled 20:30 HKT deliberately: after the HK close (16:00) and BEFORE the US
# open (21:30 HKT summer), so the US lane's newest bar is always a completed
# session — screening a just-opened partial bar is the failure mode that would
# quietly poison the sample instead of protecting it.
set -uo pipefail

ROOT="/Users/yongouyang/projects/agentic-trading"
cd "$ROOT" || exit 1

for lane in hk us; do
  pnpm -C apps/api ops:catchup --lane "$lane"
  rc=$?
  case "$rc" in
    0)  echo "$(date '+%F %T') $lane: up to date, nothing to do" ;;
    10) echo "$(date '+%F %T') $lane: session missing — running the chain"
        bash scripts/daily-chain.sh "$lane"
        echo "$(date '+%F %T') $lane: catch-up chain exit=$?" ;;
    *)  echo "$(date '+%F %T') $lane: GUARD FAILED rc=$rc — not running (a blind run could duplicate a session)" ;;
  esac
done
