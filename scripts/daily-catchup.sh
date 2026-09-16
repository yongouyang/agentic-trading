#!/usr/bin/env bash
# THE daily pipeline (created 2026-09-11 as an evening catch-up; promoted
# 2026-09-14). The machine is realistically only on in the evening, so the
# 06:10 (US) / 16:50 (HK) launchd jobs — which almost never fired — were
# removed on 2026-09-14. These two guarded evening slots are now the ONLY
# daily runs for both lanes.
#
# Guarded: ops:catchup decides per lane whether a completed session exists that
# no run has screened. Since 2026-09-14 the guard no longer trusts the store
# alone — it PROBES the provider for the newest completed session (2026-09-14
# incident: machine powered off until 20:05 HKT, nothing fetched, store ended
# 2026-09-11 == last screened, and the store-only guard read "up to date" while
# that day's HK session went unscreened). Exit 10 from the guard means "run it",
# 0 means "up to date", anything else means the guard itself failed and we do
# NOT run (a blind run would duplicate a session and inflate the very sample
# this protects).
#
# Scheduled 20:30 (primary) and 23:03 (second chance) HKT. At 20:30 the HK
# lane's same-day session is complete (close 16:00) and the US lane processes
# the PREVIOUS US session (closed 04:00/05:00 HKT that morning) — lag 1 by
# construction. 23:03 lands mid-US-session and is safe ONLY because of the
# session-close filter (quant-core sessionClosed, applied at the fetch/upsert
# boundary in screen:daily): Yahoo's still-forming bar never enters the store,
# so the guard screens the previous COMPLETED US session. Screening a
# just-opened partial bar is the failure mode that would quietly poison the
# sample instead of protecting it.
set -uo pipefail

ROOT="/Users/yongouyang/projects/agentic-trading"
cd "$ROOT" || exit 1

# launchd runs with a bare PATH (/usr/bin:/bin:...). Same export as
# daily-chain.sh — and the reason is a measured one: without it this script dies
# on `pnpm: command not found`, the guard never runs, and the job still looks
# installed and ARMED (runs=0 in `launchctl list`). That is precisely the silent
# failure a68f687 fixed for the chains, and this script reintroduced it by calling
# pnpm without the export.
export PATH="$HOME/Library/pnpm/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# node is NOT in any of those on this machine — it lives at ~/.local/bin/node
# (a symlink into ~/.hermes) and under nvm. Verified against launchd's REAL
# environment, which is `PATH => /usr/bin:/bin:/usr/sbin:/sbin` (not /usr/bin:/bin
# as I first assumed, and not a login shell's PATH): with only the line above,
# `command -v node` finds nothing and this script dies with `node: not found`
# while the other chains work. So use the SAME nvm fallback as daily-chain.sh,
# ops-health.sh and weekly-maintenance.sh rather than a bespoke one — a second
# resolver is a second thing to get wrong, which is exactly what happened.
if ! command -v node >/dev/null 2>&1; then
  # sort -V on the version with the leading v stripped — the old field sort
  # (-k1.2n) compared "24" as "4" and would pick v9.x over v24.x.
  NODE_VER=$(ls "$HOME"/.nvm/versions/node 2>/dev/null | sed 's/^v//' | sort -V | tail -1)
  [ -n "$NODE_VER" ] && export PATH="$HOME/.nvm/versions/node/v$NODE_VER/bin:$PATH"
fi

# Report the WORST outcome across lanes (mirroring daily-chain.sh's
# worst-exit): a guard failure or a failed catch-up chain must not exit 0, or
# launchd records a clean job for an evening that did nothing.
RC=0
for lane in hk us; do
  pnpm -C apps/api ops:catchup --lane "$lane"
  rc=$?
  case "$rc" in
    0)  echo "$(date '+%F %T') $lane: up to date, nothing to do" ;;
    10) echo "$(date '+%F %T') $lane: session missing — running the chain"
        bash scripts/daily-chain.sh "$lane"
        chain_rc=$?
        echo "$(date '+%F %T') $lane: catch-up chain exit=$chain_rc"
        [ "$chain_rc" -gt "$RC" ] && RC=$chain_rc ;;
    *)  echo "$(date '+%F %T') $lane: GUARD FAILED rc=$rc — not running (a blind run could duplicate a session)"
        [ "$rc" -gt "$RC" ] && RC=$rc ;;
  esac
done
echo "daily-catchup worst-exit=$RC"
exit "$RC"
