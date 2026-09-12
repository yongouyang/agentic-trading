#!/usr/bin/env node
/**
 * Yahoo dividends sweep for the liquid Databento vendor universe.
 *
 * WHAT: for every distinct survivor symbol of the liquid vendor universe
 * (scripts/databento/liquid-survivors.csv — 1,490 symbols / 1,844 series,
 * >=252 bars, adv20 >= $20M, computed by p2p3_from_db.py from dev.db),
 * fetch FULL-history Yahoo v8 chart events (same endpoint as
 * yahoo-splits-sweep.mjs and apps/api's yahoo-market-data.provider.ts:163-164:
 * period1=0, interval=1d, events=div%2Csplit) and record every dividend with
 * ex_date >= WINDOW_START (the archive's first session, 2021-09-02) as
 * symbol, exDate, amount, source=yahoo.
 *
 * WHY: the "Yahoo now, Databento if earned" dividends fork. The vendor lane's
 * Gate-2 differential is biased UPWARD by missing dividends (benchmark holds
 * the payers, a trend-selected portfolio doesn't); this harvest makes the
 * harvested fraction adjustable. Databento reference CA data is paywalled
 * (403 no_subscription) and is bought only if the lane graduates.
 *
 * STAYS OUT OF THE DB: 551 of these symbols also exist in the picker
 * universe; writing into the picker-side CorporateAction table would
 * double-count against the F10/yahoo CA refresh path. The CSV artifact is
 * what the future vendor-screen loader consumes; DB loading is part of the
 * loader session.
 *
 * COURTESY (mirrors yahoo-splits-sweep.mjs): strictly sequential, base
 * spacing 500ms + 0-50% uniform jitter, UA "Mozilla/5.0" (project convention:
 * long Chrome UA draws immediate 429), one retry ladder 5s/15s on
 * 429/5xx/timeout. HTTP 404 / "No data found" is a first-class outcome
 * ("not-found") — the scoping session measured ~20% 404s on this universe.
 * At 1,490 symbols expect ~16 min.
 *
 * RESUMABLE: JSONL journal; re-running skips terminal statuses
 * (ok / not-found) and re-fetches transient failures.
 *
 * Usage:
 *   node scripts/databento/yahoo-dividends-sweep.mjs [--spacing 500] \
 *     [--limit N] [--symbols AAPL,NVDA] [--yes]
 *
 * Outputs (next to this script):
 *   yahoo-dividends-sweep.jsonl   journal (one line per symbol)
 *   yahoo-dividends.csv           symbol,ex_date,amount,source
 *   yahoo-dividends-residual.txt  symbols 404'd or fetch-failed (the
 *                                 disclosed upper-bound looseness)
 *   yahoo-dividends-coverage.txt  coverage summary
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UA = "Mozilla/5.0";
const WINDOW_START = "2021-09-02";
const ENDPOINT = (symbol) => {
  const now = Math.floor(Date.now() / 1000);
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=0&period2=${now}&interval=1d&events=div%2Csplit`;
};

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const survivorsPath = flag("survivors", path.join(HERE, "liquid-survivors.csv"));
const journalPath = flag("journal", path.join(HERE, "yahoo-dividends-sweep.jsonl"));
const csvPath = flag("csv", path.join(HERE, "yahoo-dividends.csv"));
const residualPath = flag("residual", path.join(HERE, "yahoo-dividends-residual.txt"));
const coveragePath = flag("coverage", path.join(HERE, "yahoo-dividends-coverage.txt"));
const spacingMs = Number(flag("spacing", 500));
const limit = flag("limit", null) === null ? Infinity : Number(flag("limit"));
const onlySymbols = flag("symbols", null)?.split(",").filter(Boolean);
const approved = argv.includes("--yes") || Boolean(onlySymbols);

function loadSurvivors() {
  const lines = readFileSync(survivorsPath, "utf8").trim().split("\n").slice(1);
  return lines.map((l) => {
    const [symbol, vendorKeys] = l.split(",");
    return { symbol, vendorKeys };
  });
}

function loadJournal() {
  const done = new Map();
  if (!existsSync(journalPath)) return done;
  for (const line of readFileSync(journalPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); done.set(r.symbol, r); } catch { /* torn line: refetch */ }
  }
  return done;
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

async function fetchDividends(symbol) {
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
      const currency = d?.meta?.currency ?? null;
      const dividends = Object.values(d?.events?.dividends ?? {})
        .map((x) => ({ date: isoDate(x.date), amount: x.amount }))
        .filter((x) => x.date >= WINDOW_START && Number.isFinite(x.amount))
        .sort((a, b) => a.date.localeCompare(b.date));
      return { symbol, status: "ok", currency, dividends };
    } catch (e) {
      if (attempt === 2) return { symbol, status: `exception:${String(e?.message ?? e).slice(0, 80)}` };
      await sleep(attempt === 0 ? 5_000 : 15_000);
    }
  }
  return { symbol, status: "retries-exhausted" };
}

const survivors = loadSurvivors();
const all = onlySymbols ?? survivors.map((s) => s.symbol);
const done = loadJournal();
const TERMINAL = new Set(["ok", "not-found"]);
const todo = all.filter((s) => !TERMINAL.has(done.get(s)?.status)).sort();
if (!onlySymbols) {
  console.log(`survivor symbols: ${all.length} | journaled: ${done.size} | to fetch: ${todo.length}${limit ? ` (limit ${limit})` : ""}`);
  console.log(`spacing ${spacingMs}ms+jitter => est ${((todo.length * spacingMs * 1.25) / 60000).toFixed(0)}min | journal: ${journalPath}`);
  if (!approved) { console.error("refusing to start a bulk Yahoo sweep without --yes"); process.exit(2); }
}

let fetched = 0;
for (const symbol of onlySymbols ? onlySymbols : todo.slice(0, limit)) {
  const rec = await fetchDividends(symbol);
  rec.fetchedAt = new Date().toISOString();
  appendFileSync(journalPath, JSON.stringify(rec) + "\n");
  done.set(symbol, rec);
  fetched++;
  if (fetched % 100 === 0) {
    console.log(`  ${fetched}/${todo.length} fetched | ${done.size} journaled | ${new Date().toISOString()}`);
  }
}

// ---- artifacts ---------------------------------------------------------------
const rows = ["symbol,ex_date,amount,source"];
let nEvents = 0;
const anomalies = [];
for (const r of [...done.values()].sort((a, b) => a.symbol.localeCompare(b.symbol))) {
  if (r.currency && r.currency !== "USD") anomalies.push(`${r.symbol}: currency=${r.currency}`);
  for (const dv of r.dividends ?? []) {
    if (!(dv.amount > 0)) { anomalies.push(`${r.symbol} ${dv.date}: non-positive amount ${dv.amount}`); continue; }
    if (dv.amount > 100) anomalies.push(`${r.symbol} ${dv.date}: large amount ${dv.amount}`);
    rows.push([r.symbol, dv.date, String(+dv.amount.toPrecision(12)), "yahoo"].join(","));
    nEvents++;
  }
}
writeFileSync(csvPath, rows.join("\n") + "\n");

const tally = {};
for (const r of done.values()) {
  const k = r.status === "ok" ? ((r.dividends ?? []).length ? "ok-with-dividends" : "ok-no-dividends") : r.status;
  tally[k] = (tally[k] ?? 0) + 1;
}
const failedSyms = [...done.values()]
  .filter((r) => r.status !== "ok")
  .sort((a, b) => a.symbol.localeCompare(b.symbol))
  .map((r) => `${r.symbol}\t${r.status}`);
writeFileSync(residualPath, failedSyms.join("\n") + (failedSyms.length ? "\n" : ""));

const n = done.size || 1;
const pct = (x) => `${x} (${((100 * x) / n).toFixed(1)}%)`;
const coverage = [
  `Yahoo dividends sweep coverage — ${done.size} survivor symbols`,
  `  ok, has dividends in window (>= ${WINDOW_START}): ${pct(tally["ok-with-dividends"] ?? 0)}`,
  `  ok, genuinely no dividends (HTTP 200, empty events): ${pct(tally["ok-no-dividends"] ?? 0)}`,
  `  not-found (404 / no data): ${pct(tally["not-found"] ?? 0)}`,
  `  fetch-failed (transient, re-run to retry): ${pct(n - (tally["ok-with-dividends"] ?? 0) - (tally["ok-no-dividends"] ?? 0) - (tally["not-found"] ?? 0))}`,
  `  dividend events harvested: ${nEvents}`,
  `  anomalies: ${anomalies.length ? "" : "none"}`,
  ...anomalies.map((a) => `    ${a}`),
  `artifacts: ${csvPath}`,
  `           ${residualPath} (${failedSyms.length} symbols)`,
];
writeFileSync(coveragePath, coverage.join("\n") + "\n");
console.log(coverage.join("\n"));
const complete = all.every((s) => TERMINAL.has(done.get(s)?.status));
console.log(complete ? "SWEEP COMPLETE for all survivor symbols."
  : "resume by re-running (transient failures are re-fetched).");
