/**
 * Phase 6A A5 — reading the panel and signals CSVs.
 *
 * Two failure modes are the reason this has tests at all, and neither would
 * announce itself:
 *  - reading an empty cell as `0` instead of `null`, which invents a signal
 *    value at the neutral point of a z-score;
 *  - reading a signals file against the wrong symbol axis, which produces a
 *    confident wrong IC.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAligned,
  readMaskCsv,
  readNumberCsv,
  resolvePanelDir,
} from "../../src/backtest/panel-read.js";

const dir = mkdtempSync(path.join(tmpdir(), "panel-read-"));
const write = (name: string, text: string): string => {
  const p = path.join(dir, name);
  writeFileSync(p, text);
  return p;
};

describe("wide CSV reading", () => {
  it("keeps an empty cell as null, never as 0", () => {
    const file = write("a.csv", "date,AAA,BBB\n2024-01-02,1.5,\n2024-01-03,,\n");
    const m = readNumberCsv(file);
    expect(m.symbols).toEqual(["AAA", "BBB"]);
    expect(m.dates).toEqual(["2024-01-02", "2024-01-03"]);
    expect(m.values).toEqual([
      [1.5, null],
      [null, null],
    ]);
    // The distinction the module exists to preserve: 0 is a value, null is not.
    expect(m.values[0]![1]).toBeNull();
    expect(m.values[0]![1]).not.toBe(0);
  });

  it("parses negative, exponent and integer forms without inventing NaN", () => {
    const file = write("b.csv", "date,AAA\n2024-01-02,-0.25\n2024-01-03,1.5e-7\n2024-01-04,1000\n");
    const m = readNumberCsv(file);
    expect(m.values.map((r) => r[0])).toEqual([-0.25, 1.5e-7, 1000]);
  });

  it("tolerates a trailing newline and rejects a missing date column", () => {
    expect(readNumberCsv(write("c.csv", "date,AAA\n2024-01-02,1\n")).dates).toEqual(["2024-01-02"]);
    expect(() => readNumberCsv(write("d.csv", "symbol,AAA\n2024-01-02,1\n"))).toThrow(/date/);
  });

  it("reads the mask's three codes plus the blank 'not evaluated' cell", () => {
    const file = write("m.csv", "date,AAA,BBB,CCC\n2024-01-02,2,1,0\n2024-01-03,,,\n");
    const m = readMaskCsv(file);
    expect(m.values).toEqual([
      [2, 1, 0],
      [null, null, null],
    ]);
    // A blank is NOT 0: outside the replay window the screen was never run.
    expect(m.values[1]![0]).toBeNull();
  });

  it("refuses a mask value it does not understand rather than coercing it", () => {
    expect(() => readMaskCsv(write("bad.csv", "date,AAA\n2024-01-02,3\n"))).toThrow(/is not 0, 1 or 2/);
  });
});

describe("alignment", () => {
  const want = { symbols: ["AAA", "BBB"], dates: ["2024-01-02", "2024-01-03"] };

  it("accepts an identically shaped axis", () => {
    expect(() => assertAligned("x", { symbols: ["AAA", "BBB"], dates: ["2024-01-02", "2024-01-03"] }, want)).not.toThrow();
  });

  it("throws on a reordered symbol column, a different count, or a shifted date axis", () => {
    expect(() => assertAligned("x", { symbols: ["BBB", "AAA"], dates: want.dates }, want)).toThrow(/column 0 is BBB/);
    expect(() => assertAligned("x", { symbols: ["AAA"], dates: want.dates }, want)).toThrow(/1 symbol columns/);
    expect(() => assertAligned("x", { symbols: want.symbols, dates: ["2024-01-02", "2024-01-04"] }, want)).toThrow(/sessions/);
  });
});

describe("panel directory resolution", () => {
  const root = mkdtempSync(path.join(tmpdir(), "panels-"));
  const mk = (name: string, market: string) => {
    const d = path.join(root, name);
    require("node:fs").mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "manifest.json"), JSON.stringify({ market, fingerprint: name }));
    writeFileSync(path.join(d, "close.csv"), "date,AAA\n2024-01-02,1\n");
    writeFileSync(path.join(d, "eligible.csv"), "date,AAA\n2024-01-02,2\n");
    return d;
  };

  it("picks the newest fingerprinted directory for the lane", () => {
    mk("us-2021-09-20_2026-09-17-1254s-555n-1b-aaaa", "US");
    const newest = mk("us-2021-09-20_2026-09-18-1255s-555n-2b-bbbb", "US");
    mk("hk-2021-09-13_2026-09-18-1232s-145n-3b-cccc", "HK");
    expect(resolvePanelDir(root, "US")).toBe(path.join(root, "us-2021-09-20_2026-09-18-1255s-555n-2b-bbbb"));
    expect(resolvePanelDir(root, "US")).toBe(newest);
  });

  it("accepts an explicit directory only when it belongs to the lane", () => {
    const hk = path.join(root, "hk-2021-09-13_2026-09-18-1232s-145n-3b-cccc");
    expect(resolvePanelDir(root, "HK", hk)).toBe(hk);
    expect(() => resolvePanelDir(root, "US", hk)).toThrow(/is a HK panel/);
  });

  it("says what to run when no panel exists", () => {
    expect(() => resolvePanelDir(mkdtempSync(path.join(tmpdir(), "empty-")), "US")).toThrow(/panel:export/);
  });
});
