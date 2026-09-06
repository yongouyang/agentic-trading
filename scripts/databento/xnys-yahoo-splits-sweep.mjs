#!/usr/bin/env node
/**
 * XNYS new-symbol Yahoo splits sweep — one-off companion to
 * yahoo-splits-sweep.mjs (same pacing, retry ladder, and CSV schema;
 * see docs/research-databento-import.md §4.2/§5).
 *
 * Universe: scripts/databento/xnys-new-symbols-for-sweep.txt minus the 15
 * NYSE test symbols (NTEST-G..Z, CTEST-A, MTEST-A, PTEST) → 12 symbols.
 * Yahoo format uses '-' for class shares (BRK-A), matching the file as-is.
 *
 * Output: scripts/databento/xnys-yahoo-splits.csv (+ .jsonl journal).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UA = "Mozilla/5.0";
const WINDOW_START = "2021-09-03"; // XNYS archive start (manifest first_date)
const ENDPOINT = (symbol) => {
  const now = Math.floor(Date.now() / 1000);
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=0&period2=${now}&interval=1d&events=div%2Csplit`;
};

const journalPath = path.join(HERE, "xnys-yahoo-splits.jsonl");
const csvPath = path.join(HERE, "xnys-yahoo-splits.csv");
const spacingMs = 500;

const EXCLUDE = new Set([
  "NTEST-G","NTEST-H","NTEST-I","NTEST-J","NTEST-K","NTEST-L","NTEST-M",
  "NTEST-N","NTEST-O","NTEST-Q","NTEST-Y","NTEST-Z","CTEST-A","MTEST-A","PTEST",
]);
const symbols = readFileSync(path.join(HERE, "xnys-new-symbols-for-sweep.txt"), "utf8")
  .split("\n").map((s) => s.trim()).filter(Boolean)
  .filter((s) => !EXCLUDE.has(s)).sort();

const done = new Map();
if (existsSync(journalPath)) {
  for (const line of readFileSync(journalPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); done.set(r.symbol, r); } catch { /* refetch */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequestAt = 0;
async function throttle() {
  const target = lastRequestAt + spacingMs + Math.random() * spacingMs * 0.5;
  const wait = target - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}
const isoDate = (epochSec) => new Date(epochSec * 1000).toISOString().slice(0, 10);

async function fetchSplits(symbol) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await throttle();
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 25_000);
      let res;
      try { res = await fetch(ENDPOINT(symbol), { headers: { "User-Agent": UA }, signal: ac.signal }); }
      finally { clearTimeout(t); }
      if (res.status === 404) return { symbol, status: "not-found" };
      if (res.status === 429 || res.status >= 500) { await sleep(attempt === 0 ? 5_000 : 15_000); continue; }
      if (res.status !== 200) return { symbol, status: `http-${res.status}` };
      const chart = (await res.json())?.chart;
      if (chart?.error) {
        const absent = /No data found|Not Found/i.test(JSON.stringify(chart.error));
        return { symbol, status: absent ? "not-found" : `chart-error:${JSON.stringify(chart.error).slice(0, 80)}` };
      }
      const d = chart?.result?.[0];
      const meta = d?.meta ? {
        longName: d.meta.longName ?? d.meta.shortName ?? null,
        exchange: d.meta.fullExchangeName ?? d.meta.exchangeName ?? null,
        firstTrade: d.meta.firstTradeDate ? isoDate(d.meta.firstTradeDate) : null,
      } : null;
      const splits = Object.values(d?.events?.splits ?? {})
        .map((s) => ({ date: isoDate(s.date), numerator: s.numerator, denominator: s.denominator }))
        .filter((s) => s.date >= WINDOW_START)
        .sort((a, b) => a.date.localeCompare(b.date));
      return { symbol, status: "ok", meta, splits };
    } catch (e) {
      if (attempt === 2) return { symbol, status: `exception:${String(e?.message ?? e).slice(0, 80)}` };
      await sleep(attempt === 0 ? 5_000 : 15_000);
    }
  }
  return { symbol, status: "retries-exhausted" };
}

function writeCsv() {
  const rows = ["symbol,ex_date,event,ratio_new,ratio_old,factor"];
  for (const r of [...done.values()].sort((a, b) => a.symbol.localeCompare(b.symbol))) {
    for (const s of r.splits ?? []) {
      if (!s.numerator || !s.denominator) continue;
      const factor = s.numerator / s.denominator;
      rows.push([r.symbol, s.date, factor > 1 ? "FORWARD_SPLIT" : "REVERSE_SPLIT",
        s.numerator, s.denominator, String(+factor.toPrecision(12))].join(","));
    }
  }
  writeFileSync(csvPath, rows.join("\n") + "\n");
}

console.log(`symbols to sweep: ${symbols.length} (${symbols.join(" ")})`);
const TERMINAL = new Set(["ok", "not-found"]);
for (const symbol of symbols) {
  if (TERMINAL.has(done.get(symbol)?.status)) { console.log(`skip ${symbol} (${done.get(symbol).status})`); continue; }
  const rec = await fetchSplits(symbol);
  rec.fetchedAt = new Date().toISOString();
  appendFileSync(journalPath, JSON.stringify(rec) + "\n");
  done.set(symbol, rec);
  console.log(`${symbol}: ${rec.status}${rec.meta ? ` | ${rec.meta.longName} @ ${rec.meta.exchange}` : ""}${rec.splits?.length ? ` | splits: ${JSON.stringify(rec.splits)}` : ""}`);
}
writeCsv();
console.log(`CSV -> ${csvPath}`);
