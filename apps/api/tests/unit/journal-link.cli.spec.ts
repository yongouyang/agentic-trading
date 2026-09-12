/**
 * `journal:link` — the store plumbing for the trade linkage.
 *
 * The pure linkage lives in packages/quant-core (16 tests there). What this
 * covers is the part only the store can get wrong: reading conviction from the
 * verdictJson BLOB, joining memberships through ScreenRun.sessionDate, and using
 * the SAME adjusted-series derivation as the screen so a journal return and a
 * signal return are comparable.
 */
import { describe, expect, it } from "vitest";
import { loadMemberships, loadSeries, parseJournalArgs, renderJournal, runJournal } from "../../src/cli/journal-link.js";

const SESSIONS = ["2026-09-09", "2026-09-10", "2026-09-11"];

/** A stub store with one HK list (sessionDate-bearing) and AAPL bars. */
function stubPrisma() {
  return {
    screenRun: {
      // Faithful to the real query `where: { sessionDate: { not: "" } }` — a stub
      // that returned the legacy row anyway would test a filter that Prisma
      // applies before the code ever sees it.
      findMany: async () =>
        [
          { id: 18, market: "HK", sessionDate: "2026-09-11" },
          { id: 16, market: "US", sessionDate: "" },
        ].filter((r) => r.sessionDate !== ""),
    },
    screenResult: {
      findMany: async () => [
        { runId: 18, symbol: "0066.HK", rank: 1 },
        { runId: 18, symbol: "1113.HK", rank: 2 },
        { runId: 16, symbol: "AAPL", rank: 1 }, // belongs to a legacy run
      ],
    },
    deepDiveRun: {
      // Faithful to the real query `where: { screenRunId: { in }, status:
      // "complete", source: "chain" }` — an adhoc run must be filtered out by
      // the query, which only works if the stub applies it too.
      findMany: async ({ where }: any = {}) =>
        [
          {
            screenRunId: 18,
            status: "complete",
            source: "chain",
            reports: [
              { symbol: "0066.HK", verdictJson: JSON.stringify({ conviction: 0.4, abstain: false }) },
              { symbol: "1113.HK", verdictJson: JSON.stringify({ conviction: 0.1, abstain: true }) },
            ],
          },
          // A later ad-hoc re-dive of the same screen run: its conviction must
          // NEVER overwrite the chain run's — the journal measures decisions
          // against the published list.
          {
            screenRunId: 18,
            status: "complete",
            source: "adhoc",
            reports: [{ symbol: "0066.HK", verdictJson: JSON.stringify({ conviction: 0.99, abstain: false }) }],
          },
        ].filter((d) => (where?.source ? d.source === where.source : true) && (where?.status ? d.status === where.status : true)),
    },
    instrument: { findMany: async () => [{ id: 1, symbol: "0066.HK" }, { id: 2, symbol: "1113.HK" }] },
    bar: {
      findMany: async () => [
        ...[40, 41, 42].map((c, i) => ({ instrumentId: 1, date: SESSIONS[i], open: c, high: c, low: c, close: c, volume: 1 })),
        ...[50, 49, 48].map((c, i) => ({ instrumentId: 2, date: SESSIONS[i], open: c, high: c, low: c, close: c, volume: 1 })),
      ],
    },
    corporateAction: { findMany: async () => [] },
  } as any;
}

describe("journal:link — arg surface", () => {
  it("parses flags and rejects junk", () => {
    expect(parseJournalArgs([])).toEqual({ file: "trades.csv", json: false, topN: 10, lookbackSessions: 5 });
    expect(parseJournalArgs(["--", "--json", "--file", "t.csv", "--top", "5", "--lookback", "0"])).toEqual({
      file: "t.csv",
      json: true,
      topN: 5,
      lookbackSessions: 0,
    });
    expect(() => parseJournalArgs(["--top", "-1"])).toThrow(/non-negative integer/);
    expect(() => parseJournalArgs(["--nope"])).toThrow(/unknown argument/);
  });
});

describe("journal:link — the store join", () => {
  it("reads conviction from the blob and ignores runs with no sessionDate", async () => {
    const m = await loadMemberships(stubPrisma());
    // The legacy US run contributes nothing: without a sessionDate a list cannot
    // be placed in time, so linking against it would be guessing.
    expect(m.map((x) => `${x.market}:${x.symbol}`)).toEqual(["HK:0066.HK", "HK:1113.HK"]);
    expect(m[0]!.conviction).toBe(0.4);
    // An abstain carries no conviction, and must not be read as a 0.
    expect(m[1]!.conviction).toBeNull();
  });

  it("an adhoc run's report never overwrites the chain run's conviction", async () => {
    const m = await loadMemberships(stubPrisma());
    // The stub's adhoc run re-dives 0066.HK at conviction 0.99; the chain
    // run's 0.4 must stand.
    expect(m.find((x) => x.symbol === "0066.HK")!.conviction).toBe(0.4);
  });

  it("derives series through the same adjusted path the screen uses", async () => {
    const s = await loadSeries(stubPrisma(), ["0066.HK"]);
    expect(s.get("0066.HK")!.closes).toEqual([40, 41, 42]);
    expect(s.get("0066.HK")!.dates).toEqual(SESSIONS);
  });

  it("links a real HK trade end to end, with the counterfactual", async () => {
    // Bought 0066.HK (rank 1, conviction 0.4) the session after the list, held to
    // the last bar. The counterfactual is the list's top-N over the same window.
    const csv = `date,symbol,side,quantity,price
2026-09-10,HK.00066,buy,1000,40.5
2026-09-11,HK.00066,sell,1000,42.0`;
    const r = await runJournal(stubPrisma(), { file: "t.csv", json: false, topN: 2, lookbackSessions: 5 }, csv);
    const buy = r.linked.find((l) => l.trade.side === "buy")!;
    expect(buy.trade.symbol).toBe("00066.HK"); // zero-padded to the store's form
    expect(buy.onList).toBe(false); // the list is for 09-11, the buy was 09-10
    expect(r.summary.buys).toBe(1);
    expect(renderJournal(r)).toMatch(/JOURNAL LINKAGE/);
  });

  it("reports skipped rows in the rendered output, so coverage cannot look better than it is", async () => {
    const csv = `date,symbol,side,quantity,price
2026-09-10,HK.00066,buy,1000,40.5
not-a-date,HK.00066,buy,1000,40.5`;
    const r = await runJournal(stubPrisma(), { file: "t.csv", json: false, topN: 2, lookbackSessions: 5 }, csv);
    expect(r.skipped).toHaveLength(1);
    expect(renderJournal(r)).toMatch(/skipped rows \(1\)/);
  });
});
