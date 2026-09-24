#!/usr/bin/env python3
"""Futu enrichment for the daily screen shortlist (Phase A) + server-side
discovery lane (Phase B).

Reads a screen report (apps/api/reports/<date>-<LANE>.json), pulls
deterministic per-symbol data from Futu OpenD, and writes
logs/futu/enrich-<date>-<lane>.json.

Design rules:
- Never fails the daily chain: OpenD down -> status=unavailable, exit 0;
  per-symbol/per-endpoint failures are recorded and skipped.
- No LLM tokens. No writes to the trading account. Quote-API only.
"""
import argparse
import datetime as dt
import json
import logging
import os
import sys
import time
from pathlib import Path

logging.disable(logging.WARNING)

HOST = os.environ.get("FUTU_HOST", "127.0.0.1")
PORT = int(os.environ.get("FUTU_PORT", "11111"))
CALL_GAP = 0.15          # seconds between API calls
RATE_LIMIT = 30          # per-endpoint: 30 calls / 30 s (observed server msg)
RATE_WINDOW = 31.0
EARNINGS_WINDOW_DAYS = 30
EARNINGS_FLAG_DAYS = 7
DISCOVERY_NUM = 100

# Phase B discovery filters (server-side; no kline-quota cost)
DISCOVERY_MIN_FLOAT_MCAP = 2e9
DISCOVERY_MIN_VOLUME_RATIO = 2.0

# Expected-N/A responses that are not failures (e.g. ETFs have no analyst
# consensus / Morningstar coverage)
SKIP_MARKERS = ("Only stocks and REITs are supported",)


def log(msg):
    print(f"[enrich {dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def to_futu_code(symbol: str, market: str) -> str:
    if market.upper() == "US":
        return f"US.{symbol}"
    if market.upper() == "HK":
        # Yahoo '0700.HK' / '0700' -> Futu 'HK.00700' (5-digit)
        digits = symbol.split(".")[0]
        return f"HK.{digits.zfill(5)}"
    return f"{market.upper()}.{symbol}"


class Enricher:
    def __init__(self):
        from collections import deque

        from futu import OpenQuoteContext
        self.ctx = OpenQuoteContext(host=HOST, port=PORT)
        self.ctx.set_sync_query_connect_timeout(15)
        self._calls = {}  # endpoint name -> deque of call timestamps
        self._deque = deque

    def close(self):
        try:
            self.ctx.close()
        except Exception:
            pass

    def _throttle(self, key):
        """Per-endpoint sliding window: RATE_LIMIT calls per RATE_WINDOW."""
        dq = self._calls.setdefault(key, self._deque())
        now = time.monotonic()
        while dq and now - dq[0] > RATE_WINDOW:
            dq.popleft()
        if len(dq) >= RATE_LIMIT:
            wait = RATE_WINDOW - (now - dq[0])
            log(f"rate limit window full for {key}; sleeping {wait:.0f}s")
            time.sleep(wait)
            now = time.monotonic()
            while dq and now - dq[0] > RATE_WINDOW:
                dq.popleft()
        dq.append(time.monotonic())
        time.sleep(CALL_GAP)

    def _call(self, fn, *args, **kwargs):
        self._throttle(getattr(fn, "__name__", str(fn)))
        try:
            ret, data = fn(*args, **kwargs)[:2]
        except Exception as e:
            ret, data = -1, f"{type(e).__name__}: {e}"
        if ret == 0:
            return data
        err = str(data)
        if any(m in err for m in SKIP_MARKERS):
            return None
        raise RuntimeError(err[:300])

    # ---- Phase A endpoints -------------------------------------------------

    def capital_flow_5d(self, code):
        """5-session net main inflow. DAY period; INTRADAY as today-only
        fallback."""
        try:
            df = self._call(self.ctx.get_capital_flow, code, period_type="DAY")
            if df is None:
                return None
            rows = df.tail(5)
            return {
                "period": "day",
                "sessions": int(len(rows)),
                "main_net_inflow": round(float(rows["main_in_flow"].sum()), 2),
                "last_date": str(rows["capital_flow_item_time"].iloc[-1])[:10],
            }
        except Exception:
            df = self._call(self.ctx.get_capital_flow, code)  # INTRADAY
            return {
                "period": "intraday",
                "sessions": 1,
                "main_net_inflow": round(float(df["main_in_flow"].iloc[-1]), 2)
                if len(df) else None,
                "last_date": str(df["capital_flow_item_time"].iloc[-1])[:10]
                if len(df) else None,
            }

    def short_volume(self, code):
        df = self._call(self.ctx.get_daily_short_volume, code)
        if df is None or len(df) == 0:
            return None
        ratio_cols = [c for c in df.columns if "ratio" in c.lower()]
        ratio_col = ("short_volume_ratio" if "short_volume_ratio" in df.columns
                     else ratio_cols[0] if ratio_cols else None)
        latest = df.iloc[0]  # newest-first
        out = {
            "latest_date": str(latest.get("timestamp_str", ""))[:10],
            "short_ratio": (round(float(latest[ratio_col]), 2)
                            if ratio_col else None),
        }
        if ratio_col:
            out["avg_5d"] = round(float(df[ratio_col].head(5).mean()), 2)
        return out

    def analyst_consensus(self, code):
        d = self._call(self.ctx.get_research_analyst_consensus, code)
        if not isinstance(d, dict) or d.get("total") in (None, 0):
            return None
        return {
            "rating": d.get("rating"),
            "analysts": d.get("total"),
            "pt_avg": d.get("average"),
            "pt_high": d.get("highest"),
            "pt_low": d.get("lowest"),
            "buy_pct": d.get("buy"),
            "date": d.get("update_time_str"),
        }

    def morningstar(self, code):
        d = self._call(self.ctx.get_research_morningstar_report, code)
        if not isinstance(d, dict) or d.get("star_rating") in (None, 0):
            return None
        return {
            "stars": d.get("star_rating"),
            "fair_value": d.get("fair_value"),
            "date": d.get("star_update_time_str"),
        }

    # ---- Phase B ------------------------------------------------------------

    @staticmethod
    def _parse_record(rec: str) -> dict:
        """FilterStockData renders as 'key:value  key:value ...'."""
        import re
        out = {}
        for m in re.finditer(r"(\w+):(\S+)", rec):
            key, val = m.group(1), m.group(2)
            try:
                out[key] = float(val)
            except ValueError:
                out[key] = val
        return out

    def discovery(self, market):
        """Server-side discovery lane: large-caps with unusual volume in an
        established daily uptrend (MA bullish alignment 3 consecutive days).

        Note: StockField.CUR_PRICE_TO_HIGHEST52_WEEKS_RATIO was evaluated and
        rejected 2026-09-24 — its US-lane values are broken (top matches were
        OTC ADRs at '19.5' while real large caps near their highs scored ~0).
        """
        from futu import (KLType, PatternFilter, SimpleFilter, SortDir,
                          StockField)

        def sf(field, lo=None, sort=None):
            f = SimpleFilter()
            f.stock_field = field
            f.is_no_filter = False  # required — default None silently skips min
            if lo is not None:
                f.filter_min = lo
            if sort is not None:
                f.sort = sort
            return f

        f_mcap = sf(StockField.FLOAT_MARKET_VAL, lo=DISCOVERY_MIN_FLOAT_MCAP)
        f_vol = sf(StockField.VOLUME_RATIO, lo=DISCOVERY_MIN_VOLUME_RATIO,
                   sort=SortDir.DESCEND)
        p_trend = PatternFilter()
        p_trend.stock_field = StockField.MA_ALIGNMENT_LONG
        p_trend.ktype = KLType.K_DAY
        p_trend.is_no_filter = False
        p_trend.consecutive_period = 3

        last_exc = None
        for filters in ([f_mcap, f_vol, p_trend], [f_mcap, p_trend], [f_mcap]):
            try:
                _last, count, recs = self._call(self.ctx.get_stock_filter,
                                                market.upper(), filters,
                                                num=DISCOVERY_NUM)
                rows = [self._parse_record(str(r)) for r in recs]
                break
            except Exception as e:
                last_exc = e
        else:
            raise last_exc
        codes = [r.get("stock_code") for r in rows if r.get("stock_code")]
        return {
            "filters": ["FLOAT_MARKET_VAL>=2e9", "VOLUME_RATIO>=2",
                        "MA_ALIGNMENT_LONG(K_DAY,3d)"][: len(filters)],
            "total_matches": int(count),
            "count": len(codes),
            "codes": codes,
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True, help="screen report JSON path")
    ap.add_argument("--out", default="logs/futu/", help="output directory")
    ap.add_argument("--no-discovery", action="store_true")
    args = ap.parse_args()

    report_path = Path(args.report)
    report = json.loads(report_path.read_text())
    market = report["market"].upper()
    session_date = report["date"]
    shortlist = report.get("shortlist", [])

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"enrich-{session_date}-{market.lower()}.json"

    result = {
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "report": str(report_path),
        "market": market,
        "session_date": session_date,
        "status": "ok",
        "enrichment": [],
        "discovery": None,
    }

    # Connectivity probe — the SDK connects lazily and queries block
    # indefinitely against a dead gateway (SIGALRM handlers don't fire inside
    # the SDK's internal wait), so probe in a subprocess with a hard timeout.
    import subprocess
    try:
        probe = subprocess.run(
            [sys.executable, "-c",
             "import os,sys;from futu import OpenQuoteContext;"
             "c=OpenQuoteContext(host=os.environ.get('FUTU_HOST','127.0.0.1'),"
             "port=int(os.environ.get('FUTU_PORT','11111')));"
             "r,_=c.get_global_state();c.close();sys.exit(0 if r==0 else 1)"],
            env=os.environ.copy(), timeout=60, capture_output=True)
        if probe.returncode != 0:
            raise RuntimeError(f"probe exit={probe.returncode} "
                               f"{probe.stderr.decode()[:150]}")
        enr = Enricher()
    except Exception as e:
        result["status"] = "unavailable"
        result["error"] = f"OpenD connect failed: {e}"
        out_path.write_text(json.dumps(result, indent=2))
        log(f"OpenD unavailable -> wrote {out_path}")
        return 0

    # Earnings calendar: one market-level call for the window.
    earnings_by_symbol = {}
    try:
        begin = session_date
        end = (dt.date.fromisoformat(session_date)
               + dt.timedelta(days=EARNINGS_WINDOW_DAYS)).isoformat()
        df = enr._call(enr.ctx.get_earnings_calendar, market,
                       begin_date=begin, end_date=end)
        sec_col = "security" if "security" in df.columns else "code"
        date_col = next((c for c in df.columns if "date" in c.lower()), None)
        for _, row in df.iterrows():
            earnings_by_symbol[str(row[sec_col])] = str(row[date_col])[:10]
        log(f"earnings calendar: {len(earnings_by_symbol)} events")
    except Exception as e:
        log(f"earnings calendar unavailable: {e}")

    for item in shortlist:
        symbol, code = item["symbol"], to_futu_code(item["symbol"], market)
        entry = {"symbol": symbol, "code": code, "rank": item.get("rank"),
                 "errors": {}}
        for key, fn in (("capital_flow", enr.capital_flow_5d),
                        ("short_volume", enr.short_volume),
                        ("analyst_consensus", enr.analyst_consensus),
                        ("morningstar", enr.morningstar)):
            try:
                entry[key] = fn(code)
            except Exception as e:
                entry[key] = None
                entry["errors"][key] = str(e)[:150]
        ed = earnings_by_symbol.get(code)
        if ed:
            entry["earnings"] = {
                "date": ed,
                "days_to": (dt.date.fromisoformat(ed)
                            - dt.date.fromisoformat(session_date)).days,
                "imminent": (dt.date.fromisoformat(ed)
                             - dt.date.fromisoformat(session_date)).days
                <= EARNINGS_FLAG_DAYS,
            }
        else:
            entry["earnings"] = None
        result["enrichment"].append(entry)
        log(f"{code} done ({len(entry['errors'])} errors)")

    if not args.no_discovery:
        try:
            disc = enr.discovery(market)
            core = {to_futu_code(i["symbol"], market) for i in shortlist}
            futu = set(disc["codes"])
            disc["overlap"] = sorted(futu & core)
            disc["futu_only"] = sorted(futu - core)
            disc["core_only"] = sorted(core - futu)
            result["discovery"] = disc
            log(f"discovery: {len(futu)} futu-lane, "
                f"{len(disc['overlap'])} overlap")
        except Exception as e:
            result["discovery"] = {"status": "unavailable", "error": str(e)[:300]}
            log(f"discovery unavailable: {e}")

    enr.close()

    n_err = sum(len(e["errors"]) for e in result["enrichment"])
    if n_err and all(e["errors"] for e in result["enrichment"]):
        result["status"] = "partial"
    out_path.write_text(json.dumps(result, indent=2))
    log(f"wrote {out_path} ({len(result['enrichment'])} symbols, "
        f"{n_err} endpoint errors)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
