/**
 * Trade-journal linkage (packages/quant-core/src/journal.ts).
 *
 * Written BEFORE any trade history exists, so the analysis cannot be fitted to a
 * result. The tests therefore pin the things that must be true of ANY journal:
 * that a broker's symbol codes reach the store's convention, that a bad row is
 * reported rather than dropped, that the counterfactual is measured over the
 * trade's own window, and that an open position is marked to market rather than
 * counted as a completed outcome.
 */
import { describe, expect, it } from "vitest";
import {
  JournalSeries,
  LinkedTrade,
  ListMembership,
  JournalTrade,
  linkTrades,
  normalizeSymbol,
  parseTradesCsv,
  summarizeJournal,
} from "../src/journal.js";

/** Futu-style export: broker codes, a fee column, one deliberately bad row. */
const CSV = `date,symbol,side,quantity,price,fee
2026-09-14,US.AAPL,buy,10,230.50,1.99
2026-09-15,HK.02269,buy,500,45.20,28.00
2026-09-16,US.AAPL,sell,10,241.00,2.10
2026-09-17,US.MSFT,buy,5,510.00,2.50`;

function series(symbol: string, dates: string[], closes: number[]): JournalSeries {
  return { symbol, dates, closes };
}

const DATES = ["2026-09-10", "2026-09-11", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"];

describe("journal — broker symbols to the store's convention", () => {
  it("maps Futu codes, zero-padding HK to the store's 5 digits", () => {
    expect(normalizeSymbol("US.AAPL")).toBe("AAPL");
    expect(normalizeSymbol("HK.02269")).toBe("02269.HK");
    expect(normalizeSymbol("HK.700")).toBe("00700.HK");
    expect(normalizeSymbol("hk.700")).toBe("00700.HK");
  });

  it("passes SH/SZ codes through unchanged — the store covers US/HK only", () => {
    // Mapping SH.600000 to 600000.HK invented a fake symbol; the honest mapping
    // is none at all (parseTradesCsv rejects these rows with a reason).
    expect(normalizeSymbol("SH.600000")).toBe("SH.600000");
    expect(normalizeSymbol("sz.000001")).toBe("SZ.000001");
  });

  it("passes through anything already in the store's form, so a hand-written file works", () => {
    expect(normalizeSymbol("AAPL")).toBe("AAPL");
    expect(normalizeSymbol("2269.HK")).toBe("2269.HK"); // no re-padding: already suffixed
  });
});

describe("journal — parsing reports bad rows instead of dropping them", () => {
  it("parses a real-shaped export and normalizes symbols and side", () => {
    const { trades, skipped } = parseTradesCsv(CSV);
    expect(trades).toHaveLength(4);
    expect(skipped).toHaveLength(0);
    expect(trades[0]).toEqual({ date: "2026-09-14", symbol: "AAPL", side: "buy", quantity: 10, price: 230.5, fee: 1.99 });
    expect(trades[1]!.symbol).toBe("02269.HK");
  });

  it("keeps a bad row visible with a reason (coverage must not look better than it is)", () => {
    const { trades, skipped } = parseTradesCsv(
      `date,symbol,side,quantity,price,fee
2026-09-14,AAPL,buy,10,230.50,1.99
14/09/2026,AAPL,buy,10,230.50,0
2026-09-15,AAPL,hold,10,230.50,0
2026-09-15,,buy,10,230.50,0
2026-09-15,AAPL,buy,0,230.50,0
2026-09-15,AAPL,buy,10,230.50,-1`,
    );
    expect(trades).toHaveLength(1);
    expect(skipped).toHaveLength(5);
    expect(skipped.map((s) => s.reason).join(" ")).toMatch(/YYYY-MM-DD/);
    expect(skipped.map((s) => s.reason).join(" ")).toMatch(/side must be buy\|sell/);
    expect(skipped.map((s) => s.reason).join(" ")).toMatch(/empty symbol/);
    expect(skipped.map((s) => s.reason).join(" ")).toMatch(/positive numbers/);
    expect(skipped.map((s) => s.reason).join(" ")).toMatch(/non-negative/);
  });

  it("treats a missing fee as zero, and a quoted field with a comma survives", () => {
    const { trades } = parseTradesCsv(`date,symbol,side,quantity,price
2026-09-14,"AAPL",buy,10,230.50`);
    expect(trades[0]!.fee).toBe(0);
    expect(trades[0]!.symbol).toBe("AAPL");
  });

  it("names the missing columns rather than parsing garbage", () => {
    expect(() => parseTradesCsv("date,symbol\n2026-09-14,AAPL")).toThrow(/missing column\(s\): side, quantity, price/);
  });

  it("returns empty on an empty file instead of throwing", () => {
    expect(parseTradesCsv("")).toEqual({ trades: [], skipped: [] });
  });

  it("rejects SH/SZ codes visibly instead of mapping them to fake .HK symbols", () => {
    const { trades, skipped } = parseTradesCsv(`date,symbol,side,quantity,price
2026-09-14,SH.600000,buy,100,10.50
2026-09-14,SZ.000001,buy,100,12.00
2026-09-14,US.AAPL,buy,10,230.50`);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.symbol).toBe("AAPL");
    expect(skipped).toHaveLength(2);
    expect(skipped[0]!.reason).toMatch(/SH\/SZ codes are not supported/);
    expect(skipped.map((s) => s.raw).join(" ")).not.toMatch(/\.HK/);
  });
});

describe("journal — the linkage", () => {
  const memberships: ListMembership[] = [
    // AAPL on the 09-14 list at rank 3, deep-dived at 0.45.
    { market: "US", sessionDate: "2026-09-14", symbol: "AAPL", rank: 3, conviction: 0.45 },
    { market: "US", sessionDate: "2026-09-14", symbol: "MSFT", rank: 1, conviction: 0.3 },
    { market: "US", sessionDate: "2026-09-14", symbol: "NVDA", rank: 2, conviction: null },
    // HK list on 09-15.
    { market: "HK", sessionDate: "2026-09-15", symbol: "02269.HK", rank: 2, conviction: -0.1 },
    { market: "HK", sessionDate: "2026-09-15", symbol: "00700.HK", rank: 1, conviction: 0.2 },
  ];
  const seriesBySymbol = new Map<string, JournalSeries>([
    ["AAPL", series("AAPL", DATES, [220, 225, 230, 232, 241, 244, 246])],
    ["MSFT", series("MSFT", DATES, [500, 505, 510, 512, 520, 515, 518])],
    ["NVDA", series("NVDA", DATES, [180, 182, 185, 186, 190, 188, 191])],
    ["02269.HK", series("02269.HK", DATES, [44, 44.5, 45, 45.2, 46, 46.5, 47])],
    ["00700.HK", series("00700.HK", DATES, [400, 402, 405, 406, 408, 410, 412])],
  ]);
  const parsed = parseTradesCsv(CSV).trades;

  it("links a closed trade to the list it came from, and to the counterfactual", () => {
    const linked = linkTrades(parsed, memberships, seriesBySymbol);
    const aapl = linked.find((l) => l.trade.symbol === "AAPL")!;
    expect(aapl.entry).toBe("2026-09-14");
    expect(aapl.exit).toBe("2026-09-16");
    expect(aapl.open).toBe(false);
    expect(aapl.onList).toBe(true);
    expect(aapl.listRank).toBe(3);
    expect(aapl.conviction).toBe(0.45);
    // Adjusted closes 230 -> 241.
    expect(aapl.realizedReturn).toBeCloseTo(241 / 230 - 1, 10);
    // Counterfactual: the 09-14 top-10 list (AAPL/MSFT/NVDA) over the SAME window.
    const listRet = (241 / 230 - 1 + (520 / 510 - 1) + (190 / 185 - 1)) / 3;
    expect(aapl.listReturn).toBeCloseTo(listRet, 10);
    expect(aapl.delta).toBeCloseTo(aapl.realizedReturn! - listRet, 10);
  });

  it("marks an unpaired buy to market rather than reporting a completed outcome", () => {
    const linked = linkTrades(parsed, memberships, seriesBySymbol);
    const msft = linked.find((l) => l.trade.symbol === "MSFT")!;
    expect(msft.open).toBe(true);
    expect(msft.exit).toBeNull(); // never sold — marked to market instead
    // Entry is the buy's OWN session (09-17, close 515), not the first bar: the
    // trade was made when it was made.
    expect(msft.entry).toBe("2026-09-17");
    expect(msft.realizedReturn).toBeCloseTo(518 / 515 - 1, 10);
    expect(msft.holdSessions).toBe(1); // 09-17 -> 09-18
  });

  it("counts an off-list name as off-list, with no rank or conviction invented", () => {
    const off = parseTradesCsv(`date,symbol,side,quantity,price
2026-09-15,US.TSLA,buy,1,300`).trades;
    const linked = linkTrades(off, memberships, seriesBySymbol);
    expect(linked[0]!.onList).toBe(false);
    expect(linked[0]!.listRank).toBeNull();
    expect(linked[0]!.conviction).toBeNull();
  });

  it("stops counting a list as current once it is older than the lookback", () => {
    // A stale list must not be treated as the list you were looking at.
    const late = parseTradesCsv(`date,symbol,side,quantity,price\n2026-09-18,US.AAPL,buy,1,246`).trades;
    const fresh = linkTrades(late, memberships, seriesBySymbol, { lookbackSessions: 5 });
    expect(fresh[0]!.onList).toBe(true); // 09-14 -> 09-18 is within 5 sessions
    const strict = linkTrades(late, memberships, seriesBySymbol, { lookbackSessions: 0 });
    expect(strict[0]!.onList).toBe(false); // only the same session counts
  });

  it("keeps an orphan sell visible instead of inventing an entry", () => {
    const orphan = parseTradesCsv(`date,symbol,side,quantity,price\n2026-09-16,US.AAPL,sell,10,241`).trades;
    const linked = linkTrades(orphan, memberships, seriesBySymbol);
    expect(linked).toHaveLength(1);
    expect(linked[0]!.realizedReturn).toBeNull();
    expect(linked[0]!.onList).toBe(false);
  });
});

describe("journal — quantity-aware FIFO", () => {
  // XXX climbs 10/session from 100; list members YYY (+5/session) and ZZZ (+10/session).
  const memberships: ListMembership[] = [
    { market: "US", sessionDate: "2026-09-10", symbol: "XXX", rank: 1, conviction: 0.5 },
    { market: "US", sessionDate: "2026-09-10", symbol: "YYY", rank: 2, conviction: null },
    { market: "US", sessionDate: "2026-09-10", symbol: "ZZZ", rank: 3, conviction: null },
  ];
  const seriesBySymbol = new Map<string, JournalSeries>([
    ["XXX", series("XXX", DATES, [100, 110, 120, 130, 140, 150, 160])],
    ["YYY", series("YYY", DATES, [100, 105, 110, 115, 120, 125, 130])],
    ["ZZZ", series("ZZZ", DATES, [50, 55, 60, 65, 70, 75, 80])],
  ]);
  const trades = (rows: string) => parseTradesCsv(`date,symbol,side,quantity,price\n${rows}`).trades;
  const listWindow = (from: string, to: string, members: [string, number[]][] = []) => {
    const all: [string, number[]][] = [
      ["XXX", [100, 110, 120, 130, 140, 150, 160]],
      ["YYY", [100, 105, 110, 115, 120, 125, 130]],
      ["ZZZ", [50, 55, 60, 65, 70, 75, 80]],
      ...members,
    ];
    const rs = all.map(([, closes]) => {
      const i = DATES.indexOf(from);
      const j = DATES.indexOf(to);
      return closes[j]! / closes[i]! - 1;
    });
    return rs.reduce((a, b) => a + b, 0) / rs.length;
  };

  it("a partial sell keeps the row open: weighted realized piece + MTM remainder", () => {
    const linked = linkTrades(trades("2026-09-11,US.XXX,buy,10,110\n2026-09-14,US.XXX,sell,4,120"), memberships, seriesBySymbol);
    expect(linked).toHaveLength(1);
    const row = linked[0]!;
    expect(row.open).toBe(true);
    expect(row.exit).toBe("2026-09-14"); // last partial-exit session
    const expected = 0.4 * (120 / 110 - 1) + 0.6 * (160 / 110 - 1);
    expect(row.realizedReturn).toBeCloseTo(expected, 10);
    // The counterfactual uses the SAME weights over the SAME windows.
    const listExpected = 0.4 * listWindow("2026-09-11", "2026-09-14") + 0.6 * listWindow("2026-09-11", "2026-09-18");
    expect(row.listReturn).toBeCloseTo(listExpected, 10);
    expect(row.delta).toBeCloseTo(expected - listExpected, 10);
    expect(row.holdSessions).toBe(5); // still open: entry -> latest bar
  });

  it("a full scale-out in two sells is quantity-weighted (unequal pieces)", () => {
    const linked = linkTrades(
      trades("2026-09-10,US.XXX,buy,10,100\n2026-09-11,US.XXX,sell,3,110\n2026-09-14,US.XXX,sell,7,120"),
      memberships,
      seriesBySymbol,
    );
    expect(linked).toHaveLength(1);
    const row = linked[0]!;
    expect(row.open).toBe(false);
    expect(row.exit).toBe("2026-09-14");
    const expected = 0.3 * 0.1 + 0.7 * 0.2;
    expect(row.realizedReturn).toBeCloseTo(expected, 10);
    const listExpected = 0.3 * listWindow("2026-09-10", "2026-09-11") + 0.7 * listWindow("2026-09-10", "2026-09-14");
    expect(row.listReturn).toBeCloseTo(listExpected, 10);
    expect(row.holdSessions).toBe(2); // 09-10 -> 09-14
  });

  it("scaling in: buy 100, buy 100, sell 150 — lot 1 closes, lot 2 is half closed + half MTM", () => {
    const linked = linkTrades(
      trades("2026-09-10,US.XXX,buy,100,100\n2026-09-14,US.XXX,buy,100,120\n2026-09-16,US.XXX,sell,150,150"),
      memberships,
      seriesBySymbol,
    );
    expect(linked).toHaveLength(2);
    const [lot1, lot2] = linked;
    expect(lot1!.open).toBe(false);
    expect(lot1!.exit).toBe("2026-09-16");
    expect(lot1!.realizedReturn).toBeCloseTo(140 / 100 - 1, 10);
    expect(lot2!.open).toBe(true);
    expect(lot2!.exit).toBe("2026-09-16");
    expect(lot2!.realizedReturn).toBeCloseTo(0.5 * (140 / 120 - 1) + 0.5 * (160 / 120 - 1), 10);
  });

  it("sell quantity beyond the open lots becomes a visible orphan row", () => {
    const linked = linkTrades(trades("2026-09-10,US.XXX,buy,5,100\n2026-09-11,US.XXX,sell,8,110"), memberships, seriesBySymbol);
    expect(linked).toHaveLength(2);
    const buy = linked.find((l) => l.trade.side === "buy")!;
    expect(buy.open).toBe(false);
    expect(buy.realizedReturn).toBeCloseTo(0.1, 10);
    const excess = linked.find((l) => l.trade.side === "sell")!;
    expect(excess.realizedReturn).toBeNull();
    expect(excess.onList).toBe(false);
    expect(excess.open).toBe(false);
  });

  it("an unpriceable piece drops its weight from BOTH sides and renormalizes", () => {
    // The 09-12 sell maps to session 09-11 == the entry, so that piece has no
    // return; only the 09-14 piece may count, on either side.
    const linked = linkTrades(
      trades("2026-09-11,US.XXX,buy,10,110\n2026-09-12,US.XXX,sell,4,112\n2026-09-14,US.XXX,sell,6,120"),
      memberships,
      seriesBySymbol,
    );
    const row = linked[0]!;
    expect(row.realizedReturn).toBeCloseTo(120 / 110 - 1, 10);
    expect(row.listReturn).toBeCloseTo(listWindow("2026-09-11", "2026-09-14"), 10);
    expect(row.delta).toBeCloseTo(row.realizedReturn! - row.listReturn!, 10);
  });
});

describe("journal — per-market counterfactual topN", () => {
  // HK list with 6 members: ranks 1-5 flat, rank 6 far better — so topN 5 vs
  // 10 give measurably different counterfactuals.
  const hkMembers: ListMembership[] = [1, 2, 3, 4, 5, 6].map((rank) => ({
    market: "HK",
    sessionDate: "2026-09-15",
    symbol: `H${rank}.HK`,
    rank,
    conviction: null,
  }));
  const seriesBySymbol = new Map<string, JournalSeries>(
    [1, 2, 3, 4, 5].map((n) => [`H${n}.HK`, series(`H${n}.HK`, DATES, [100, 100, 100, 100, 100, 100, 110])] as const),
  );
  seriesBySymbol.set("H6.HK", series("H6.HK", DATES, [100, 100, 100, 100, 100, 100, 140]));
  seriesBySymbol.set("00001.HK", series("00001.HK", DATES, [100, 100, 100, 100, 100, 100, 110])); // the traded name
  const buy = parseTradesCsv(`date,symbol,side,quantity,price\n2026-09-15,HK.00001,buy,10,100`).trades;

  it("a per-market topN prices the HK counterfactual over the displayed 5, not 10", () => {
    const perMarket = linkTrades(buy, hkMembers, seriesBySymbol, { topN: { US: 10, HK: 5 } });
    expect(perMarket[0]!.listReturn).toBeCloseTo(0.1, 10); // H1..H5 only
    const scalar = linkTrades(buy, hkMembers, seriesBySymbol, { topN: 10 });
    expect(scalar[0]!.listReturn).toBeCloseTo((5 * 0.1 + 0.4) / 6, 10); // all six
    expect(scalar[0]!.listReturn).not.toBeCloseTo(perMarket[0]!.listReturn!, 10);
  });

  it("a market with no entry in the record falls back to 10", () => {
    const linked = linkTrades(buy, hkMembers, seriesBySymbol, { topN: { US: 3 } });
    expect(linked[0]!.listReturn).toBeCloseTo((5 * 0.1 + 0.4) / 6, 10);
  });
});

describe("journal — the summary", () => {
  const memberships: ListMembership[] = [{ market: "US", sessionDate: "2026-09-14", symbol: "AAPL", rank: 1, conviction: 0.5 }];
  const seriesBySymbol = new Map<string, JournalSeries>([["AAPL", series("AAPL", DATES, [220, 225, 230, 232, 241, 244, 246])]]);

  it("reports coverage over BUYS, not over all rows", () => {
    // A sell is not a decision to buy something new, so counting it would inflate
    // coverage (or deflate it) for no reason.
    const linked = linkTrades(parseTradesCsv(CSV).trades, memberships, seriesBySymbol);
    const s = summarizeJournal(linked);
    expect(s.buys).toBe(3); // AAPL, 02269.HK, MSFT
    // A matched sell folds into the buy row it closes, so rows are DECISIONS:
    // 3 buys + 0 orphans, not 4 executions.
    expect(s.trades).toBe(3);
    expect(s.onList).toBe(1);
    expect(s.coverage).toBeCloseTo(1 / 3, 10);
  });

  it("separates on-list from off-list outcomes and reports the decision delta", () => {
    const linked = linkTrades(parseTradesCsv(CSV).trades, memberships, seriesBySymbol);
    const s = summarizeJournal(linked);
    expect(s.meanReturnOnList).not.toBeNull();
    expect(s.meanDeltaVsList).not.toBeNull();
    expect(s.meanConviction).toBeCloseTo(0.5, 10);
  });

  it("survives an empty journal", () => {
    const s = summarizeJournal([]);
    expect(s.trades).toBe(0);
    expect(s.coverage).toBe(0);
    expect(s.meanReturnOnList).toBeNull();
  });

  it("counts matched vs open positions so a partial journal is not read as complete", () => {
    const linked = linkTrades(parseTradesCsv(CSV).trades, memberships, seriesBySymbol);
    const s = summarizeJournal(linked);
    expect(s.matched).toBe(1); // AAPL closed
    expect(s.open).toBe(2); // 02269.HK and MSFT still held
  });
});
