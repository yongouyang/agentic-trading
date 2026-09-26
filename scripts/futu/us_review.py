#!/usr/bin/env python3
"""Weekend/holiday US market review for a set of held ETFs, from Futu OpenD.

Answers "how did the market do and what happened to MY holdings" in one pass:
market context (breadth, movers, sectors, macro calendar, Fed probabilities),
then per holding a trend read computed locally from daily klines (MA/RSI/ATR/
momentum/drawdown), plus capital flow, short volume, dividends, Futu's own
technical-anomaly signals, and news.

Read-only. No unlock. Writes logs/futu/us-review-<date>.json and prints a
compact digest to stdout.

    .venv/bin/python scripts/futu/us_review.py
    .venv/bin/python scripts/futu/us_review.py --codes US.SMH US.XLV
    .venv/bin/python scripts/futu/us_review.py --out logs/futu/
"""
import argparse
import datetime as dt
import json
import logging
import sys
import time
from collections import deque
from pathlib import Path

logging.disable(logging.WARNING)

HOST, PORT = "127.0.0.1", 11111
# Held positions (2026-09-26). Override with --codes.
DEFAULT_CODES = ["US.SMH", "US.SPMO", "US.XLV", "US.QQQM", "US.WQTM", "US.DTCR", "US.NLR"]
# Context: broad market, size/style, plus all 11 GICS sector ETFs.
CONTEXT_CODES = [
    "US.SPY", "US.QQQ", "US.IWM", "US.DIA", "US.RSP", "US.TLT", "US.GLD", "US.VIXY",
    "US.XLK", "US.XLV", "US.XLE", "US.XLF", "US.XLU", "US.XLP",
    "US.XLI", "US.XLY", "US.XLB", "US.XLRE", "US.XLC",
]
THEME_NEWS = {
    "semiconductor": "semiconductor",
    "quantum computing": "quantum computing",
    "uranium nuclear power": "uranium",
    "data center infrastructure": "data center",
    "healthcare sector": "healthcare stocks",
    "S&P 500 momentum": "S&P 500",
    "US market": "US stock market",
    "Federal Reserve": "Federal Reserve",
}
# 8 calls / 30 s globally: at or below the strictest per-endpoint cap observed
# (get_stock_filter and position_list_query are 10/30 s; quote endpoints ~30/30 s).
RATE_LIMIT, RATE_WINDOW = 8, 31.0


class Client:
    def __init__(self):
        from futu import OpenQuoteContext
        self.ctx = OpenQuoteContext(host=HOST, port=PORT)
        self.ctx.set_sync_query_connect_timeout(15)
        self.calls = deque()
        self.errors = {}

    def close(self):
        try:
            self.ctx.close()
        except Exception:
            pass

    def _throttle(self):
        now = time.monotonic()
        while self.calls and now - self.calls[0] > RATE_WINDOW:
            self.calls.popleft()
        if len(self.calls) >= RATE_LIMIT:
            time.sleep(RATE_WINDOW - (now - self.calls[0]) + 0.5)
        self.calls.append(time.monotonic())

    def call(self, label, fn, *a, **kw):
        """Return the payload tuple (everything after the ret code), or None.

        Arity is NOT uniform across this API and must not be guessed
        positionally: `get_market_state` returns (ret, df) but
        `get_top_movers_rank` returns (ret, all_count, df),
        `get_daily_short_volume` returns (ret, us_df, hk_df), and
        `get_economic_calendar` returns (ret, df, next_page, has_more).
        Taking res[1] blindly silently yields a tuple for those, which then
        reads as "endpoint returned nothing".
        """
        self._throttle()
        try:
            res = fn(*a, **kw)
        except Exception as e:
            self.errors[label] = f"{type(e).__name__}: {e}"[:200]
            return None
        if res[0] != 0:
            self.errors[label] = str(res[1])[:200]
            return None
        return res[1:]

    def payload(self, label, fn, *a, **kw):
        """The meaningful payload, wherever and however deeply the API nested it.

        Neither arity nor nesting is uniform, and guessing positionally fails
        SILENTLY (a tuple/list payload has no .to_json, so the caller sees
        "nothing returned" and reports an empty result rather than an error):
          get_market_state           -> (ret, df)
          get_top_movers_rank        -> (ret, (all_count, df))   <- tuple payload
          get_hot_list               -> (ret, (all_count, df))
          get_rise_fall_distribution -> (ret, dict)
          get_daily_short_volume     -> (ret, us_df, hk_df)
          get_economic_calendar      -> (ret, df, next_page, has_more)
          get_technical_unusual      -> (ret, dict)
        """
        return self._pick(self.call(label, fn, *a, **kw))

    @staticmethod
    def _pick(nodes):
        if not isinstance(nodes, (list, tuple)):
            return nodes
        for x in nodes:                      # a DataFrame or dict beats a scalar count
            if hasattr(x, "to_json"):
                return json.loads(x.to_json(orient="records", force_ascii=False))
            if isinstance(x, dict):
                return x
        for x in nodes:
            if isinstance(x, (list, tuple)):
                got = Client._pick(x)
                if got is not None:
                    return got
        for x in nodes:
            if x is not None:
                return x
        return None


# ---- trend maths (local, from daily klines) --------------------------------

def rsi(closes, n=14):
    import numpy as np
    c = np.asarray(closes, dtype=float)
    if len(c) < n + 1:
        return None
    d = np.diff(c)
    up = np.clip(d, 0, None)
    dn = -np.clip(d, None, 0)
    au, ad = up[:n].mean(), dn[:n].mean()          # Wilder smoothing
    for i in range(n, len(d)):
        au = (au * (n - 1) + up[i]) / n
        ad = (ad * (n - 1) + dn[i]) / n
    # Degenerate windows are ANSWERS, not missing data: no down days means RSI
    # 100 (an overbought reading), not "unavailable". Returning None here would
    # silently blank the most overbought names in the report.
    if au == 0 and ad == 0:
        return 50.0                                # no movement at all
    if ad == 0:
        return 100.0
    if au == 0:
        return 0.0
    return round(100 - 100 / (1 + au / ad), 1)


def atr_pct(high, low, close, n=14):
    import numpy as np
    h, l, c = (np.asarray(x, dtype=float) for x in (high, low, close))
    if len(c) < n + 1:
        return None
    tr = np.maximum(h[1:] - l[1:], np.maximum(abs(h[1:] - c[:-1]), abs(l[1:] - c[:-1])))
    return round(float(tr[-n:].mean() / c[-1] * 100), 2)


def trend(df):
    import numpy as np
    close = [float(r["close"]) for r in df]
    high = [float(r["high"]) for r in df]
    low = [float(r["low"]) for r in df]
    vol = [float(r["volume"]) for r in df]
    c = np.asarray(close)
    last = c[-1]

    def ma(n):
        return None if len(c) < n else round(float(c[-n:].mean()), 2)

    def chg(n):
        return None if len(c) <= n else round((last / c[-1 - n] - 1) * 100, 2)

    win = min(252, len(c))
    hi, lo = float(c[-win:].max()), float(c[-win:].min())
    ma20, ma50, ma200 = ma(20), ma(50), ma(200)
    return {
        "sessions": len(c),
        "last_date": str(df[-1].get("time_key", ""))[:10],
        "last": round(last, 2),
        "chg_1d": chg(1), "chg_5d": chg(5), "chg_20d": chg(20),
        "chg_60d": chg(60), "chg_252d": chg(252),
        "ma20": ma20, "ma50": ma50, "ma200": ma200,
        "pct_vs_ma50": None if not ma50 else round((last / ma50 - 1) * 100, 2),
        "pct_vs_ma200": None if not ma200 else round((last / ma200 - 1) * 100, 2),
        "above_200d": None if not ma200 else bool(last > ma200),
        "stacked_bullish": None if not (ma20 and ma50 and ma200) else bool(ma20 > ma50 > ma200),
        "rsi14": rsi(close),
        "atr_pct": atr_pct(high, low, close),
        "off_52w_high_pct": round((last / hi - 1) * 100, 2),
        "above_52w_low_pct": round((last / lo - 1) * 100, 2),
        "vol_ratio_20d": round(vol[-1] / (sum(vol[-20:]) / min(20, len(vol))), 2),
    }


def sanitize(node, path="", notes=None):
    """Make the artifact JSON-safe without ever dropping a payload silently:
    anything non-native is stringified AND recorded, so a report field that
    quietly became "None" can't masquerade as a missing endpoint."""
    if notes is None:
        notes = []
    if isinstance(node, dict):
        return {k: sanitize(v, f"{path}.{k}", notes) for k, v in node.items()}
    if isinstance(node, (list, tuple)):
        return [sanitize(v, f"{path}[{i}]", notes) for i, v in enumerate(node)]
    if node is None or isinstance(node, (str, int, float, bool)):
        return node
    notes.append(f"{path}: {type(node).__name__}")
    return str(node)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--codes", nargs="+", default=DEFAULT_CODES)
    ap.add_argument("--out", default="logs/futu/")
    ap.add_argument("--klines", type=int, default=400)
    ap.add_argument("--news", type=int, default=15)
    args = ap.parse_args()

    import subprocess
    probe = subprocess.run(
        [sys.executable, "-c",
         "import sys;from futu import OpenQuoteContext as Q;"
         "c=Q(host='127.0.0.1',port=11111);r,_=c.get_global_state();c.close();sys.exit(0 if r==0 else 1)"],
        capture_output=True, timeout=60)
    if probe.returncode != 0:
        sys.exit(f"OpenD unreachable: {probe.stderr.decode()[:200]}")

    c = Client()
    out = {"generated_at": dt.datetime.now().isoformat(timespec="seconds"),
           "codes": args.codes, "errors": {}, "quota_before": None}
    today = dt.date.today()
    try:
        q = c.payload("kl_quota", c.ctx.get_history_kl_quota)
        out["kline_quota_used"] = q

        # ---- market context ----
        snap = c.payload("market_snapshot", c.ctx.get_market_snapshot, args.codes + CONTEXT_CODES)
        by_code = {r["code"]: r for r in (snap or [])}
        keep = ["code", "name", "update_time", "last_price", "prev_close_price", "change_rate",
                "open_price", "high_price", "low_price", "volume", "turnover", "amplitude",
                "volume_ratio", "avg_price", "pe_ratio", "dividend_ratio_ttm",
                "highest52weeks_price", "lowest52weeks_price", "total_market_val",
                "pre_change_rate", "after_change_rate", "overnight_change_rate", "after_price"]
        out["quotes"] = {k: {f: v.get(f) for f in keep if f in v} for k, v in by_code.items()}
        out["market_state"] = c.payload("market_state", c.ctx.get_market_state, args.codes + CONTEXT_CODES)
        out["breadth"] = c.payload("rise_fall", c.ctx.get_rise_fall_distribution, market="US")
        out["top_movers"] = c.payload("top_movers", c.ctx.get_top_movers_rank, "US", count=15)
        out["hot_list"] = c.payload("hot_list", c.ctx.get_hot_list, "US", count=15)
        out["after_hours"] = c.payload("after_hours", c.ctx.get_us_after_hours_rank, count=15)
        out["rating_change"] = c.payload("rating_change", c.ctx.get_rating_change, "US", count=20)
        out["econ_calendar"] = c.payload("econ_calendar", c.ctx.get_economic_calendar,
                                         str(today), str(today + dt.timedelta(days=14)),
                                         market_list=["US"], count=40)
        out["fed_watch"] = c.payload("fed_watch", c.ctx.get_fed_watch_target_rate)
        out["macro_list"] = c.payload("macro_list", c.ctx.get_macro_indicator_list, "US")

        # ---- per holding ----
        out["holdings"] = {}
        held = {}
        for code in args.codes:
            h = {"quote": out["quotes"].get(code)}
            # An explicit `start` is required for a full year: without it the API
            # returns only ~251 daily bars, which is fewer than the 253 needed
            # for a 252-session change, so the 1y column would read as "n/a".
            kl = c.payload(f"kline:{code}", c.ctx.request_history_kline, code,
                           start=str(today - dt.timedelta(days=420)), end=str(today),
                           ktype="K_DAY", autype="qfq", max_count=args.klines)
            h["trend"] = trend(kl) if kl else None
            cf = c.payload(f"capital_flow:{code}", c.ctx.get_capital_flow, code, period_type="DAY")
            if cf:
                tail = cf[-5:]
                h["capital_flow_5d"] = {
                    "sessions": len(tail),
                    "main_net_inflow": round(sum(float(r.get("main_in_flow") or 0) for r in tail), 2),
                    "last_date": str(tail[-1].get("capital_flow_item_time", ""))[:10],
                    "last": round(float(tail[-1].get("main_in_flow") or 0), 2),
                }
            h["capital_distribution"] = c.payload(f"capdist:{code}", c.ctx.get_capital_distribution, code)
            h["short_volume"] = c.payload(f"short_vol:{code}", c.ctx.get_daily_short_volume, code, num=5)
            dv = c.payload(f"dividends:{code}", c.ctx.get_corporate_actions_dividends, code)
            if isinstance(dv, dict):
                lst = dv.get("dividend_list") or []
                h["dividends"] = {"count": len(lst), "recent": lst[:6]}
            # language_id=2 is English (1 = zh-Hant, 3 = zh-Hans); these come back
            # as prose `content` inside a dict, not a table.
            h["technical_unusual"] = c.payload(f"tech_unusual:{code}", c.ctx.get_technical_unusual,
                                                code, language_id=2)
            h["derivative_unusual"] = c.payload(f"deriv_unusual:{code}", c.ctx.get_derivative_unusual,
                                                 code, language_id=2)
            held[code] = h
            print(f"[review] {code} done", file=sys.stderr, flush=True)
        out["holdings"] = held

        # ---- news ----
        news = {}
        for label, kw in THEME_NEWS.items():
            rows = c.payload(f"news:{label}", c.ctx.get_search_news, kw, max_count=args.news)
            if rows:
                news[label] = [{"title": r.get("title"), "source": r.get("source"),
                                "date": str(r.get("publish_time", "")), "url": r.get("url"),
                                "related": r.get("related_securities")} for r in rows]
        for code in args.codes:
            tic = code.split(".")[1]
            rows = c.payload(f"news:{tic}", c.ctx.get_search_news, tic, max_count=args.news)
            if rows:
                news[tic] = [{"title": r.get("title"), "source": r.get("source"),
                              "date": str(r.get("publish_time", "")), "url": r.get("url"),
                              "related": r.get("related_securities")} for r in rows]
        out["news"] = news
    finally:
        out["errors"] = c.errors
        c.close()

    out_path = Path(args.out)
    out_path.mkdir(parents=True, exist_ok=True)
    path = out_path / f"us-review-{dt.date.today():%Y%m%d}.json"
    notes: list = []
    out = sanitize(out, "out", notes)
    out["unserializable_paths"] = notes          # loud: recorded, not dropped
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    n_err = len(c.errors)
    print(f"[review] wrote {path} ({len(args.codes)} holdings, {n_err} endpoint errors)")
    for k, v in list(c.errors.items())[:15]:
        print(f"[review]   err {k}: {v}")
    for n in notes[:10]:
        print(f"[review]   unserializable {n}")


if __name__ == "__main__":
    main()
