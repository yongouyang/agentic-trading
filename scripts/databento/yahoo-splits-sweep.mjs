#!/usr/bin/env node
/**
 * Yahoo splits sweep — authoritative ex-date + ratio registry for the
 * DataBento XNAS OHLCV-1d archive (docs/research-databento-import.md).
 *
 * WHAT: for every PLAIN symbol among the downloaded per-symbol CSVs, fetch
 * Yahoo v8 chart events (FULL history — windowed requests silently drop
 * in-window split events, measured 2026-09-03) and record every split with
 * ex_date >= WINDOW_START as symbol, ex_date, event, ratio_new, ratio_old,
 * factor. Same data `yfinance .splits` returns (same v8 endpoint underneath).
 *
 * WHY Yahoo and not Databento reference: the user's key 403s with
 * license_reference_dataset_no_subscription on corporate actions /
 * adjustment factors / security master (free, but needs portal subscribe —
 * revisit if Yahoo gaps prove too common; see research doc §4).
 *
 * COURTESY: strictly sequential, base spacing 500ms + 0–50% uniform jitter,
 * pinned short UA "Mozilla/5.0" (project convention, §4.1: long Chrome UA
 * draws immediate 429), one retry ladder 5s/15s on 429/5xx/timeout. At
 * ~16.8k plain symbols expect ≈ 3 hours.
 *
 * RESUMABLE: every result appended to a JSONL journal; re-running skips
 * symbols with a terminal status (ok / not-found), RE-FETCHES transient
 * failures (retries-exhausted / exception:* / http-* / chart-error:*), and
 * rewrites the CSV from the journal. A final full pass over the journal
 * (every symbol terminal) prints summary tallies.
 *
 * Usage:
 *   node scripts/databento/yahoo-splits-sweep.mjs \
 *     [--dir ~/Downloads/XNAS-20260902-W559N3FC8U] [--journal PATH] [--csv PATH] \
 *     [--spacing 500] [--limit N] [--symbols AAPL,NVDA] [--yes]
 *
 * Output (default into the download dir):
 *   yahoo-splits-sweep.jsonl               journal (one line per symbol)
 *   yahoo-splits-20210902-20260901.csv     consolidated registry
 */
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

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

const dataDir = path.resolve(
  (flag("dir", null) ?? path.join(os.homedir(), "Downloads/XNAS-20260902-W559N3FC8U")).replace(/^~/, os.homedir()),
);
const journalPath = flag("journal", path.join(dataDir, "yahoo-splits-sweep.jsonl"));
const csvPath = flag("csv", path.join(dataDir, "yahoo-splits-20210902-20260901.csv"));
const spacingMs = Number(flag("spacing", 500));
const limit = flag("limit", null) === null ? Infinity : Number(flag("limit"));
const onlySymbols = flag("symbols", null)?.split(",").filter(Boolean);
const approved = argv.includes("--yes") || Boolean(onlySymbols);

// ---- symbol universe (mirrors docs/research-databento-import.md §2) --------
export function symbolFromFilename(fn) {
  const m = fn.match(/^xnas-itch-\d{8}-\d{8}\.ohlcv-1d\.(.+)\.csv\.zst$/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; } // mixed %-encoding
}
export function isPlain(sym) {
  if (/[=#+]$/.test(sym)) return false; // NYSE-ADF '#', when-issued '=' , warrant '+'
  if (sym.includes("-")) return false;  // NYSE class/preferred via ADF
  if (/^[A-Z]{5}$/.test(sym) && "UWR".includes(sym.at(-1))) return false; // 5-char Nasdaq suffix convention
  return true;
}
function plainSymbols() {
  const out = new Set();
  for (const fn of readdirSync(dataDir)) {
    const s = fn.endsWith(".csv.zst") ? symbolFromFilename(fn) : null;
    if (s && isPlain(s)) out.add(s);
  }
  return [...out].sort();
}

// ---- journal ----------------------------------------------------------------
function loadJournal() {
  const done = new Map();
  if (!existsSync(journalPath)) return done;
  for (const line of readFileSync(journalPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); done.set(r.symbol, r); } catch { /* torn line: refetch */ }
  }
  return done;
}

// ---- fetch ------------------------------------------------------------------
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
      const splits = Object.values(d?.events?.splits ?? {})
        .map((s) => ({ date: isoDate(s.date), numerator: s.numerator, denominator: s.denominator }))
        .filter((s) => s.date >= WINDOW_START)
        .sort((a, b) => a.date.localeCompare(b.date));
      return { symbol, status: "ok", splits };
    } catch (e) {
      if (attempt === 2) return { symbol, status: `exception:${String(e?.message ?? e).slice(0, 80)}` };
      await sleep(attempt === 0 ? 5_000 : 15_000);
    }
  }
  return { symbol, status: "retries-exhausted" };
}

// ---- csv --------------------------------------------------------------------
function writeCsv(done) {
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
  return rows.length - 1;
}

// ---- main -------------------------------------------------------------------
const all = onlySymbols ?? plainSymbols();
const done = loadJournal();
const TERMINAL = new Set(["ok", "not-found"]);
const todo = all.filter((s) => !TERMINAL.has(done.get(s)?.status)).sort();
if (onlySymbols) {
  for (const s of onlySymbols) console.log(`(single) ${s}: fetch+journal only, csv NOT rewritten`);
} else {
  console.log(`plain symbols: ${all.length} | journaled: ${done.size} | to fetch: ${todo.length}${limit ? ` (limit ${limit})` : ""}`);
  console.log(`spacing ${spacingMs}ms+jitter ⇒ est ${((todo.length * spacingMs * 1.25) / 3600000).toFixed(1)}h | journal: ${journalPath}`);
  if (!approved) { console.error("refusing to start a bulk Yahoo sweep without --yes"); process.exit(2); }
}

let fetched = 0;
for (const symbol of onlySymbols ? onlySymbols : todo.slice(0, limit)) {
  const rec = await fetchSplits(symbol);
  rec.fetchedAt = new Date().toISOString();
  appendFileSync(journalPath, JSON.stringify(rec) + "\n");
  done.set(symbol, rec);
  fetched++;
  if (!onlySymbols && fetched % 100 === 0) {
    console.log(`  ${fetched}/${todo.length} fetched | ${done.size} journaled | ${new Date().toISOString()}`);
  }
}

if (!onlySymbols) {
  const nEvents = writeCsv(done);
  const tally = {};
  for (const r of done.values()) tally[r.status] = (tally[r.status] ?? 0) + 1;
  const complete = plainSymbols().every((s) => TERMINAL.has(done.get(s)?.status));
  console.log(`fetched ${fetched} this run; ${done.size} journaled total; CSV ${nEvents} rows -> ${csvPath}`);
  console.log(`status tally: ${JSON.stringify(tally)}`);
  console.log(complete ? "SWEEP COMPLETE for all plain symbols." : "resume by re-running (transient failures are re-fetched); CSV rewritten from journal.");
}
