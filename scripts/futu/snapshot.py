#!/usr/bin/env python3
"""Snapshot the Futu account (US securities) to JSON: account info, positions
with live quotes, open orders, and recent fills.

Reads via local OpenD (127.0.0.1:11111). Read-only; no trade unlock needed.

Examples:
  snapshot.py                          # JSON to stdout
  snapshot.py --out logs/futu/         # writes snapshot-YYYYMMDD-HHMMSS.json
  snapshot.py --days 30                # include fills from the last 30 days
  snapshot.py --days 30 --journal-csv logs/futu/trades.csv
                                       # normalized trade CSV for `journal:link`
"""
import argparse
import json
import logging
import sys
from datetime import datetime, timedelta

logging.disable(logging.WARNING)  # keep futu SDK connection chatter off stdout

from futu import (
    Currency,
    OpenQuoteContext,
    OpenSecTradeContext,
    RET_OK,
    SecurityFirm,
    TrdEnv,
    TrdMarket,
)

HOST, PORT = "127.0.0.1", 11111


def fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def records(df):
    return json.loads(df.to_json(orient="records", force_ascii=False))


def main():
    p = argparse.ArgumentParser(description="Futu portfolio snapshot via OpenD")
    p.add_argument("--out", help="directory to write snapshot JSON into")
    p.add_argument("--days", type=int, default=7, help="fill history window (default 7)")
    p.add_argument("--journal-csv", metavar="PATH",
                   help="also write the fills as the normalized trade CSV that "
                        "`pnpm -C apps/api journal:link --file <PATH>` reads "
                        "(date,symbol,side,quantity,price)")
    args = p.parse_args()

    trd = OpenSecTradeContext(
        filter_trdmarket=TrdMarket.US, host=HOST, port=PORT,
        security_firm=SecurityFirm.FUTUSECURITIES,
    )
    snap = {"captured_at": datetime.now().isoformat(timespec="seconds")}
    try:
        ret, accs = trd.get_acc_list()
        if ret != RET_OK:
            fail(f"get_acc_list failed: {accs}")
        real = accs[accs["trd_env"] == "REAL"]
        snap["account"] = records(real)[0] if len(real) else None

        snap["accinfo"] = {}
        for cur in (Currency.USD, Currency.HKD):
            ret, info = trd.accinfo_query(trd_env=TrdEnv.REAL, currency=cur)
            if ret == RET_OK and len(info):
                snap["accinfo"][cur] = records(info)[0]

        ret, pos = trd.position_list_query(trd_env=TrdEnv.REAL)
        if ret != RET_OK:
            fail(f"position_list_query failed: {pos}")
        positions = records(pos)

        codes = [p["code"] for p in positions]
        quotes = []
        if codes:
            qot = OpenQuoteContext(host=HOST, port=PORT)
            try:
                ret, q = qot.get_market_snapshot(codes)
                if ret == RET_OK:
                    keep = ["code", "last_price", "prev_close_price", "update_time"]
                    quotes = records(q[[c for c in keep if c in q.columns]])
            finally:
                qot.close()
        by_code = {q["code"]: q for q in quotes}
        for p in positions:
            q = by_code.get(p["code"])
            if q:
                p["last_price"] = q["last_price"]
                p["prev_close_price"] = q["prev_close_price"]
                p["quote_time"] = q["update_time"]
        snap["positions"] = positions

        ret, orders = trd.order_list_query(trd_env=TrdEnv.REAL)
        if ret == RET_OK:
            open_st = orders[orders["order_status"].isin(
                ["SUBMITTED", "SUBMITTING", "WAITING_SUBMIT", "FILLED_PART"])]
            snap["open_orders"] = records(open_st)

        end = datetime.now().date()
        start = end - timedelta(days=args.days)
        ret, deals = trd.history_deal_list_query(
            start=str(start), end=str(end), trd_env=TrdEnv.REAL)
        if ret == RET_OK:
            snap["fills"] = records(deals)
    finally:
        trd.close()

    # Asset taxonomy. "Fund" is overloaded here and the two senses must not be
    # conflated: an ETF position IS a fund but sits in `securities_assets` and
    # has a position row, while the money-market / mutual-fund class
    # (`fund_assets`) is separate and has NO position listing at all — verified
    # 2026-09-26: every TrdMarket filter (USFUND/HKFUND/NONE) returns 0 rows for
    # it, deal_list_query on those markets returns 0, and futu-api v10.11 ships
    # no fund context. Only its aggregate value is reachable via the API.
    acc = snap.get("accinfo", {}).get(Currency.USD)
    if acc:
        def amt(key):
            v = acc.get(key)
            return None if v in (None, "N/A") else round(float(v), 2)

        snap["asset_mix"] = {
            "eq_etf_positions_usd": round(
                sum(float(p.get("market_val") or 0) for p in snap.get("positions", [])), 2),
            "cash_usd": amt("cash"),
            "money_market_fund_usd": amt("fund_assets"),
            "securities_assets_usd": amt("securities_assets"),
            "total_assets_usd": amt("total_assets"),
        }

    if args.journal_csv:
        rows = ["date,symbol,side,quantity,price"]
        for d in sorted(snap.get("fills", []), key=lambda d: d["create_time"]):
            if d.get("status") != "OK":                    # a rejected deal is not a trade
                continue
            qty = d["qty"]
            rows.append(",".join([
                str(d["create_time"])[:10],
                str(d["code"]),
                str(d["trd_side"]).lower(),
                str(int(qty)) if float(qty).is_integer() else str(qty),
                str(d["price"]),
            ]))
        with open(args.journal_csv, "w") as f:
            f.write("\n".join(rows) + "\n")
        print(f"{args.journal_csv} ({len(rows) - 1} fills)", file=sys.stderr)

    out = json.dumps(snap, ensure_ascii=False, indent=2)
    if args.out:
        import os
        os.makedirs(args.out, exist_ok=True)
        name = f"snapshot-{datetime.now():%Y%m%d-%H%M%S}.json"
        path = os.path.join(args.out, name)
        with open(path, "w") as f:
            f.write(out + "\n")
        print(path)
    else:
        print(out)


if __name__ == "__main__":
    main()
