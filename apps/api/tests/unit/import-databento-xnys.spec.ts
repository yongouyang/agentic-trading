/**
 * Pure-function tests for the DataBento XNYS (per-day) importer: filename →
 * date decoding, space→dot symbol normalization, the NYSE-suffix/test
 * classifier port, and per-day CSV parsing (manifest matching, no-trade
 * rows, duplicates, OHLC sanity). No db, no filesystem — fixtures inline.
 */
import { describe, expect, it } from "vitest";
import {
  classifyXnysSymbol,
  dateFromFilename,
  normalizeSymbol,
  NYSE_TEST_SYMBOLS,
  parseDayCsv,
} from "../../src/cli/import-databento-xnys.js";

describe("dateFromFilename", () => {
  it("decodes day-file names to ISO dates", () => {
    expect(dateFromFilename("xnys-pillar-20240626.ohlcv-1d.csv.zst")).toBe("2024-06-26");
  });

  it("rejects non-matching filenames", () => {
    expect(dateFromFilename("manifest.json")).toBeNull();
    expect(dateFromFilename("xnys-pillar-20240626.mbp-1.csv.zst")).toBeNull();
    expect(dateFromFilename("xnas-itch-20210902-20260901.ohlcv-1d.AAPL.csv.zst")).toBeNull();
  });
});

describe("normalizeSymbol (space → dot, XNAS storage convention)", () => {
  it("normalizes share classes and leaves plain symbols alone", () => {
    expect(normalizeSymbol("BRK B")).toBe("BRK.B");
    expect(normalizeSymbol("BF A")).toBe("BF.A");
    expect(normalizeSymbol("GME")).toBe("GME");
  });
});

describe("classifyXnysSymbol", () => {
  it("keeps plain symbols and share classes", () => {
    expect(classifyXnysSymbol("GME", new Set())).toBe("plain");
    expect(classifyXnysSymbol("BRK B", new Set())).toBe("plain");
    expect(classifyXnysSymbol("A", new Set())).toBe("plain");
  });

  it("rejects NYSE space derivative suffixes that bare isPlain() misses", () => {
    for (const s of ["GME WS", "GME WSA", "XYZ WSB", "ABC U", "SPPR PRA", "SPPR PRZ", "DEF WI", "GHI RT", "JKL RTWI", "MNO WD"]) {
      expect(classifyXnysSymbol(s, new Set())).toBe("non-plain");
    }
  });

  it("rejects NYSE test names, known test symbols, and listing flag=test", () => {
    expect(classifyXnysSymbol("NTEST G", new Set())).toBe("test");
    expect(classifyXnysSymbol("NTEST Z", new Set())).toBe("test");
    expect(classifyXnysSymbol("CTEST A", new Set())).toBe("test");
    expect(classifyXnysSymbol("MTEST A", new Set())).toBe("test");
    expect(classifyXnysSymbol("PTEST", new Set())).toBe("test");
    expect(NYSE_TEST_SYMBOLS.size).toBe(15);
    expect(classifyXnysSymbol("ZVZZT", new Set())).toBe("test");
    expect(classifyXnysSymbol("ATEST", new Set(["ATEST"]))).toBe("test");
  });

  it("still applies the XNAS isPlain rules to the normalized symbol", () => {
    expect(classifyXnysSymbol("AAAUU", new Set())).toBe("non-plain"); // 5-char U suffix
    expect(classifyXnysSymbol("ZAPPW", new Set())).toBe("non-plain"); // 5-char W suffix
  });
});

describe("parseDayCsv", () => {
  const header = "ts_event,rtype,publisher_id,instrument_id,open,high,low,close,volume,symbol";
  const manifest = new Set(["CMG", "BRK B", "X"]);

  it("buffers only manifest symbols, matched on the raw space notation", () => {
    const csv = `${header}\n2024-06-26T00:00:00.000000000Z,35,9,1,2975,2980,2960,2971,12345,CMG\n` +
      `2024-06-26T00:00:00.000000000Z,35,9,2,410,411,409,410.5,999,BRK B\n` +
      `2024-06-26T00:00:00.000000000Z,35,9,3,10,11,9,10.5,500,AAPL\n` +
      `2024-06-26T00:00:00.000000000Z,35,9,4,1,1,1,1,5,GME WS\n`;
    const out = parseDayCsv(csv, manifest);
    expect(out.totalRows).toBe(4);
    expect(out.manifestRows).toBe(2);
    expect([...out.matched.keys()].sort()).toEqual(["BRK.B", "CMG"]);
    expect(out.matched.get("CMG")!.date).toBe("2024-06-26");
    expect(out.rejectedNonPlain).toBe(1); // GME WS
    expect(out.nonManifestPlain).toBe(1); // AAPL
    expect(out.duplicates).toBe(0);
  });

  it("counts duplicate (symbol,date) rows; last wins", () => {
    const csv = `${header}\n2024-06-26T00:00:00Z,35,9,1,100,101,99,100.5,1000,CMG\n` +
      `2024-06-26T00:00:00Z,35,9,1,100,102,99,101.5,2000,CMG\n`;
    const out = parseDayCsv(csv, manifest);
    expect(out.duplicates).toBe(1);
    expect(out.matched.get("CMG")!.close).toBe(101.5);
  });

  it("counts no-trade rows and OHLC violations without dropping the bar", () => {
    const csv = `${header}\n2024-06-26T00:00:00Z,35,9,1,,,,,,X\n` +
      `2024-06-26T00:00:00Z,35,9,1,100,99,101,100,1000,CMG\n`; // high<low violation
    const out = parseDayCsv(csv, manifest);
    expect(out.noTradeSkipped).toBe(1);
    expect(out.ohlcViolations).toBe(1);
    expect(out.matched.has("CMG")).toBe(true);
  });
});
