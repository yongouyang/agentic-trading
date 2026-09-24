#!/usr/bin/env python3
"""Snapshot the Futu account (US securities) to JSON: account info, positions
with live quotes, open orders, and recent fills.

Reads via local OpenD (127.0.0.1:11111). Read-only; no trade unlock needed.

Examples:
  snapshot.py                          # JSON to stdout
  snapshot.py --out logs/futu/         # writes snapshot-YYYYMMDD-HHMMSS.json
  snapshot.py --days 30                # include fills from the last 30 days
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
