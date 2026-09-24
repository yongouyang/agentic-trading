#!/usr/bin/env python3
"""Place/cancel/list Futu orders via local OpenD (127.0.0.1:11111).

Real orders require trading to be unlocked first: click the Unlock button in
the OpenD GUI and enter the trading password (GUI OpenD disables API unlock).

Examples:
  order.py buy US.QQQM 1 --price 300            # dry-run preview
  order.py buy US.QQQM 1 --price 300 --live     # submit to real account
  order.py sell US.XLV 1 --price 180 --sim      # paper account
  order.py modify <order_id> --price 170 --live # change limit of a working order
  order.py cancel <order_id> --live
  order.py list [--sim]
"""
import argparse
import logging
import sys

logging.disable(logging.WARNING)  # keep futu SDK connection chatter off stdout

from futu import (
    ModifyOrderOp,
    OpenQuoteContext,
    OpenSecTradeContext,
    OrderType,
    RET_OK,
    SecurityFirm,
    TrdEnv,
    TrdMarket,
    TrdSide,
)

HOST, PORT = "127.0.0.1", 11111


def make_ctx():
    return OpenSecTradeContext(
        filter_trdmarket=TrdMarket.US,
        host=HOST,
        port=PORT,
        security_firm=SecurityFirm.FUTUSECURITIES,
    )


def last_price(code):
    from datetime import datetime
    from zoneinfo import ZoneInfo
    qot = OpenQuoteContext(host=HOST, port=PORT)
    try:
        ret, snap = qot.get_market_snapshot([code])
        if ret != RET_OK or not len(snap):
            fail(f"cannot fetch live price for {code}: {snap if ret != RET_OK else 'empty snapshot'}")
        price = float(snap["last_price"][0])
        if price <= 0:
            fail(f"no valid live price for {code} (last_price={price})")
        age = None
        ts = str(snap["update_time"][0]) if "update_time" in snap.columns else ""
        try:
            qtime = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S").replace(
                tzinfo=ZoneInfo("America/New_York"))
            age = max(0, int((datetime.now(ZoneInfo("America/New_York")) - qtime).total_seconds()))
        except ValueError:
            pass
        return price, age
    finally:
        qot.close()


def fmt_price(code, price, age):
    fresh = f"{age}s ago" if age is not None else "age unknown"
    if age is not None and age > 900:
        fresh += " (market likely closed — stale quote)"
    return f"{code} @ {price} ({fresh})"


def check_limit(side, code, limit, price, age):
    if side == "BUY" and limit >= price:
        fail(f"BUY limit {limit} must be below the live price — {fmt_price(code, price, age)}")
    if side == "SELL" and limit <= price:
        fail(f"SELL limit {limit} must be above the live price — {fmt_price(code, price, age)}")


def env_of(args):
    return TrdEnv.SIMULATE if args.sim else TrdEnv.REAL


def fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def cmd_place(args, side):
    tif_desc = args.tif + (f" expiring {args.expire}" if args.tif == "GTD" else "")
    sess_desc = f" session={args.session}"
    if args.tif == "GTD" and not args.expire:
        fail("--expire YYYY-MM-DD is required for GTD orders")
    last, age = last_price(args.code)
    check_limit(side, args.code, args.price, last, age)
    if not args.live and not args.sim:
        print(
            f"DRY-RUN: {side} {args.qty} {args.code} @ {args.price} [{tif_desc}]{sess_desc} "
            f"(live: {fmt_price(args.code, last, age)}) "
            f"(REAL account). Re-run with --live to submit, or --sim for paper."
        )
        return
    trd = make_ctx()
    try:
        kwargs = dict(
            price=args.price,
            qty=args.qty,
            code=args.code,
            trd_side=TrdSide.BUY if side == "BUY" else TrdSide.SELL,
            order_type=OrderType.NORMAL,
            trd_env=env_of(args),
            time_in_force=args.tif,
            session=args.session,
        )
        if args.tif == "GTD":
            kwargs["expire_time"] = args.expire
        ret, res = trd.place_order(**kwargs)
        if ret != RET_OK:
            fail(f"place_order rejected: {res}")
        oid = res["order_id"][0]
        print(f"OK: {side} {args.qty} {args.code} @ {args.price} [{tif_desc}]{sess_desc} "
              f"-> order_id={oid} status={res['order_status'][0]} "
              f"({'SIMULATE' if args.sim else 'REAL'})")
    finally:
        trd.close()


def cmd_cancel(args):
    if not args.live and not args.sim:
        print(f"DRY-RUN: cancel order {args.order_id} (REAL). Re-run with --live or --sim.")
        return
    trd = make_ctx()
    try:
        ret, res = trd.modify_order(
            ModifyOrderOp.CANCEL, order_id=str(args.order_id), qty=0, price=0,
            trd_env=env_of(args),
        )
        if ret != RET_OK:
            fail(f"cancel rejected: {res}")
        print(f"OK: cancel requested for {args.order_id}")
    finally:
        trd.close()


def cmd_modify(args):
    if args.price is None and args.qty is None:
        fail("modify needs --price and/or --qty")
    trd = make_ctx()
    try:
        ret, cur = trd.order_list_query(order_id=str(args.order_id), trd_env=env_of(args))
        if ret != RET_OK or not len(cur):
            fail(f"order {args.order_id} not found")
        row = cur.iloc[0]
        new_price = args.price if args.price is not None else float(row["price"])
        new_qty = args.qty if args.qty is not None else float(row["qty"])
        if args.price is not None:
            last, age = last_price(row["code"])
            check_limit(str(row["trd_side"]).upper(), row["code"], new_price, last, age)
        if not args.live and not args.sim:
            print(
                f"DRY-RUN: modify order {args.order_id} ({row['code']} {row['trd_side']}) "
                f"qty {row['qty']} -> {new_qty}, price {row['price']} -> {new_price} (REAL). "
                f"Re-run with --live or --sim."
            )
            return
        ret, res = trd.modify_order(
            ModifyOrderOp.NORMAL, order_id=str(args.order_id),
            qty=new_qty, price=new_price, trd_env=env_of(args),
        )
        if ret != RET_OK:
            fail(f"modify rejected: {res}")
        print(f"OK: order {args.order_id} modified -> qty={new_qty} price={new_price}")
    finally:
        trd.close()


def cmd_list(args):
    trd = make_ctx()
    try:
        ret, res = trd.order_list_query(trd_env=env_of(args))
        if ret != RET_OK:
            fail(f"order_list_query failed: {res}")
        cols = [c for c in ["order_id", "code", "trd_side", "order_status",
                            "qty", "dealt_qty", "price", "create_time"] if c in res.columns]
        print(res[cols].to_string(index=False) if len(res) else "(no open orders)")
    finally:
        trd.close()


def main():
    p = argparse.ArgumentParser(description="Futu order CLI via OpenD")
    sub = p.add_subparsers(dest="cmd", required=True)

    for name in ("buy", "sell"):
        sp = sub.add_parser(name)
        sp.add_argument("code", help="e.g. US.QQQM")
        sp.add_argument("qty", type=float)
        sp.add_argument("--price", type=float, required=True, help="limit price")
        sp.add_argument("--tif", choices=["DAY", "GTD"], default="DAY",
                        help="time in force (default DAY)")
        sp.add_argument("--expire", help="expiry date YYYY-MM-DD, required for GTD")
        sp.add_argument("--session", choices=["N/A", "RTH", "ETH", "ALL", "OVERNIGHT"],
                        default="ETH",
                        help="trading session (default ETH = RTH + pre/post-market)")
        sp.add_argument("--live", action="store_true", help="submit to REAL account")
        sp.add_argument("--sim", action="store_true", help="use paper account")

    sp = sub.add_parser("cancel")
    sp.add_argument("order_id")
    sp.add_argument("--live", action="store_true")
    sp.add_argument("--sim", action="store_true")

    sp = sub.add_parser("modify", help="change qty/price of a working order")
    sp.add_argument("order_id")
    sp.add_argument("--price", type=float)
    sp.add_argument("--qty", type=float)
    sp.add_argument("--live", action="store_true")
    sp.add_argument("--sim", action="store_true")

    sp = sub.add_parser("list")
    sp.add_argument("--sim", action="store_true")
    sp.add_argument("--live", action="store_true")

    args = p.parse_args()
    if args.live and args.sim:
        fail("choose only one of --live / --sim")
    if args.cmd in ("buy", "sell"):
        cmd_place(args, args.cmd.upper())
    elif args.cmd == "cancel":
        cmd_cancel(args)
    elif args.cmd == "modify":
        cmd_modify(args)
    else:
        cmd_list(args)


if __name__ == "__main__":
    main()
