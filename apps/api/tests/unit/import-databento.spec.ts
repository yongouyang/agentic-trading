/**
 * Pure-function tests for the DataBento importer: filename/symbol decoding,
 * the isPlain/test-symbol universe classifier, ohlcv CSV row parsing
 * (incl. no-trade rows), split-registry merge dedupe, and the R4
 * return-adjustment math. No db, no filesystem — fixtures inline.
 */
import { describe, expect, it } from "vitest";
import {
  classifySymbol,
  isPlain,
  KNOWN_TEST_SYMBOLS,
  mergeSplitRegistries,
  parseInbandAdditionsCsv,
  parseOhlcvCsv,
  parseYahooRegistryCsv,
  rawReturns,
  splitAdjustedReturns,
  symbolFromFilename,
} from "../../src/cli/import-databento.js";

describe("symbolFromFilename", () => {
  it("decodes plain symbols", () => {
    expect(symbolFromFilename("xnas-itch-20210902-20260901.ohlcv-1d.AAPL.csv.zst")).toBe("AAPL");
  });

  it("URL-decodes encoded symbols", () => {
    expect(symbolFromFilename("xnas-itch-20210902-20260901.ohlcv-1d.XPOA%2B.csv.zst")).toBe("XPOA+");
  });

  it("keeps literal special characters", () => {
    expect(symbolFromFilename("xnas-itch-20210902-20260901.ohlcv-1d.BAM#.csv.zst")).toBe("BAM#");
    expect(symbolFromFilename("xnas-itch-20210902-20260901.ohlcv-1d.AAC=.csv.zst")).toBe("AAC=");
  });

  it("rejects non-matching filenames", () => {
    expect(symbolFromFilename("manifest.json")).toBeNull();
    expect(symbolFromFilename("xnas-itch-20210902-20260901.mbp-1.AAPL.csv.zst")).toBeNull();
  });
});

describe("isPlain / classifySymbol (mirrors yahoo-splits-sweep.mjs)", () => {
  it("keeps plain symbols, incl. 4-char U/W/R endings like AADR", () => {
    expect(isPlain("AAPL")).toBe(true);
    expect(isPlain("AADR")).toBe(true);
    expect(isPlain("Z")).toBe(true);
  });

  it("drops = # + suffixes, dash classes, and 5-char U/W/R suffixes", () => {
    for (const s of ["AAC=", "BAM#", "XPOA+", "HE-A", "AAAUU", "ZAPPW", "ZAPPR"]) {
      expect(isPlain(s)).toBe(false);
    }
  });

  it("classifies hardcoded known test symbols", () => {
    expect(classifySymbol("ZVZZT", new Set())).toBe("test");
    expect(classifySymbol("ZJZZT", new Set())).toBe("test");
    expect(KNOWN_TEST_SYMBOLS.has("AAPL")).toBe(false);
  });

  it("classifies listing-CSV test-flagged symbols", () => {
    expect(classifySymbol("ATEST", new Set(["ATEST"]))).toBe("test");
    expect(classifySymbol("ATEST", new Set())).toBe("plain");
  });
});

describe("parseOhlcvCsv", () => {
  const header = "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol";
  it("parses fixed-point decimal rows, date = ts_event first 10 chars", () => {
    const csv = `${header}\n2024-06-07T00:00:00.000000000Z,35,2,38,1208.000000000,1215.5,1200.25,1210.75,1234567,NVDA\n`;
    const out = parseOhlcvCsv(csv);
    expect(out.totalRows).toBe(1);
    expect(out.noTradeSkipped).toBe(0);
    expect(out.bars).toEqual([
      { date: "2024-06-07", open: 1208, high: 1215.5, low: 1200.25, close: 1210.75, volume: 1234567 },
    ]);
  });

  it("skips and counts no-trade rows (empty open/close/volume)", () => {
    const csv = `${header}\n2024-06-06T00:00:00Z,35,2,38,100,101,99,100.5,1000,X\n2024-06-07T00:00:00Z,35,2,38,,,,,,X\n`;
    const out = parseOhlcvCsv(csv);
    expect(out.totalRows).toBe(2);
    expect(out.noTradeSkipped).toBe(1);
    expect(out.bars).toHaveLength(1);
    expect(out.bars[0]!.date).toBe("2024-06-06");
  });
});

describe("split-registry merge", () => {
  const yahooCsv =
    "symbol,ex_date,event,ratio_new,ratio_old,factor\n" +
    "NVDA,2024-06-10,FORWARD_SPLIT,10,1,10\n" +
    "KTTA,2024-01-02,REVERSE_SPLIT,1,65,0.0153846\n";
  const additionsCsv =
    "symbol,ex_date,event,ratio_new,ratio_old,factor,source,confidence\n" +
    "TBLT,2024-01-02,REVERSE_SPLIT,1,65,0.0154,inband,estimated\n" +
    "NVDA,2024-06-10,FORWARD_SPLIT,10,1,9.9,inband,estimated\n" +
    "ZVZZT,2023-01-03,FORWARD_SPLIT,2,1,2,inband,estimated\n";

  it("parses both csvs with fixed source/confidence", () => {
    const y = parseYahooRegistryCsv(yahooCsv);
    const a = parseInbandAdditionsCsv(additionsCsv);
    expect(y).toHaveLength(2);
    expect(y[0]).toMatchObject({ symbol: "NVDA", source: "yahoo", confidence: "authoritative", factor: 10 });
    expect(a[0]).toMatchObject({ symbol: "TBLT", source: "inband", confidence: "estimated" });
  });

  it("dedupes on (symbol, exDate) with Yahoo winning; drops test symbols", () => {
    const { merged, conflicts, droppedTest } = mergeSplitRegistries(
      parseYahooRegistryCsv(yahooCsv),
      parseInbandAdditionsCsv(additionsCsv),
    );
    expect(conflicts).toEqual([{ symbol: "NVDA", exDate: "2024-06-10" }]);
    expect(droppedTest).toBe(1); // ZVZZT addition
    expect(merged).toHaveLength(3);
    const nvda = merged.find((r) => r.symbol === "NVDA")!;
    expect(nvda.factor).toBe(10); // Yahoo value kept, not the inband 9.9
    expect(nvda.source).toBe("yahoo");
    expect(merged.map((r) => r.symbol).sort()).toEqual(["KTTA", "NVDA", "TBLT"]);
  });
});

describe("splitAdjustedReturns — synthetic 2:1", () => {
  // As-traded series: 100 → 102 (normal +2%) → ex-date 2:1 split opens at 51.5
  // (raw −49.5% step, truly +1.96%... exact: 51.5·2/102 − 1 = +0.0098).
  const bars = [
    { date: "2024-06-06", close: 100 },
    { date: "2024-06-07", close: 102 },
    { date: "2024-06-10", close: 51.5 }, // ex-date of the 2:1
    { date: "2024-06-11", close: 52 },
  ];
  const splits = [{ exDate: "2024-06-10", factor: 2 }];

  it("removes the split step only on the ex-date", () => {
    const r = splitAdjustedReturns(bars, splits);
    expect(r.get("2024-06-07")).toBeCloseTo(0.02, 10);
    expect(r.get("2024-06-10")).toBeCloseTo((51.5 * 2) / 102 - 1, 10);
    expect(r.get("2024-06-11")).toBeCloseTo(52 / 51.5 - 1, 10);
  });

  it("rawReturns leaves the split step in (−49.5% on the ex-date)", () => {
    const r = rawReturns(bars);
    expect(r.get("2024-06-10")).toBeCloseTo(51.5 / 102 - 1, 10);
  });

  it("reverse split 1:10: price ×10, factor 0.1 neutralizes it", () => {
    const rev = [
      { date: "2024-01-01", close: 0.15 },
      { date: "2024-01-02", close: 1.55 },
    ];
    const r = splitAdjustedReturns(rev, [{ exDate: "2024-01-02", factor: 0.1 }]);
    expect(r.get("2024-01-02")).toBeCloseTo((1.55 * 0.1) / 0.15 - 1, 10);
  });

  it("is unsorted-input safe (sorts by date first)", () => {
    const shuffled = [bars[2]!, bars[0]!, bars[3]!, bars[1]!];
    const r = splitAdjustedReturns(shuffled, splits);
    expect(r.get("2024-06-10")).toBeCloseTo((51.5 * 2) / 102 - 1, 10);
  });
});
