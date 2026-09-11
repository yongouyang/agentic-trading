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
    expect(msft.exit).toBe("2026-09-18"); // last available session
    // Entry is the buy's OWN session (09-17, close 515), not the first bar: the
    // trade was made when it was made.
    expect(msft.entry).toBe("2026-09-17");
    expect(msft.realizedReturn).toBeCloseTo(518 / 515 - 1, 10);
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
