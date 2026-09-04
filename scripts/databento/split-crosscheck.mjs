#!/usr/bin/env node
/**
 * Split cross-check — joins the Yahoo split registry against the in-band
 * detector's candidates (docs/research-databento-import.md §4.3, step 7.3).
 *
 * WHAT: reads
 *   1. registry CSV   (yahoo-splits-sweep.mjs output; symbol,ex_date,event,
 *      ratio_new,ratio_old,factor — authoritative)
 *   2. sweep journal  (yahoo-splits-sweep.jsonl — per-symbol Yahoo status,
 *      distinguishes "Yahoo answered, no event" from "Yahoo 404/delisted")
 *   3. candidates CSV (split_candidate_detector.py v3 output over the archive)
 * and classifies every candidate:
 *   confirmed            same symbol + ex_date within ±1 day of a registry
 *                        event (factor agreement reported separately)
 *   yahoo-missed         no matching registry event; journal status ok
 *                        (Yahoo answered but has no event — TBLT class)
 *   yahoo-blind-spot     no matching registry event; journal status not-found
 *                        (delisted/renamed — Yahoo structurally cannot answer)
 *   out-of-scope-symbol  symbol not in the sweep journal (non-plain class)
 * Registry events with no matching candidate are classified:
 *   expected-miss        factor in [0.70, 1.43] — detector's blind band by
 *                        design (MIN_FACTOR_DEV), or factor so mild the
 *                        signature is indistinguishable from noise
 *   detector-miss        anything else — feed back into gate calibration
 *
 * Output (into --outdir):
 *   split-crosscheck-report.csv     one row per candidate + per undetected
 *                                   registry event, with classification
 *   split-registry-additions.csv    yahoo-missed + yahoo-blind-spot rows,
 *                                   schema-compatible with the registry CSV
 *                                   plus source=inband,confidence=estimated
 *
 * Usage:
 *   node scripts/databento/split-crosscheck.mjs \
 *     [--dir ~/Downloads/XNAS-20260902-W559N3FC8U] \
 *     [--registry PATH] [--journal PATH] [--candidates PATH] [--outdir PATH]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const dataDir = path.resolve(
  (flag("dir", null) ?? path.join(os.homedir(), "Downloads/XNAS-20260902-W559N3FC8U")).replace(/^~/, os.homedir()),
);
const registryPath = flag("registry", path.join(dataDir, "yahoo-splits-20210902-20260901.csv"));
const journalPath = flag("journal", path.join(dataDir, "yahoo-splits-sweep.jsonl"));
const candidatesPath = flag("candidates", path.join(dataDir, "detected-split-candidates.csv"));
const outDir = flag("outdir", dataDir);

// ±1 day tolerance: detector validation showed exact ex-dates, this only
// absorbs a timezone/edge slip without merging distinct events.
const DAY_MS = 86_400_000;
const DATE_TOLERANCE_DAYS = 1;
// Factor agreement band (log-space): detector factor is a bars-derived
// estimate, measured 10–17% off on wide-gap microcap ex-dates → 25% is loose.
const FACTOR_LOG_TOL = Math.log(1.25);
// Detector's documented blind band (v3 MIN_FACTOR_DEV): factors this close to
// 1 are excluded by design, so undetected registry events here are expected.
const BLIND_BAND = [0.7, 1.43];

function parseCsv(file) {
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const hdr = lines[0].split(",");
  return lines.slice(1).map((l) => {
    const cols = l.split(",");
    return Object.fromEntries(hdr.map((h, i) => [h, cols[i]]));
  });
}

const registry = parseCsv(registryPath).map((r) => ({
  symbol: r.symbol,
  date: r.ex_date,
  factor: Number(r.factor),
  ratioNew: r.ratio_new,
  ratioOld: r.ratio_old,
  event: r.event,
}));
const regBySymbol = new Map();
for (const r of registry) {
  if (!regBySymbol.has(r.symbol)) regBySymbol.set(r.symbol, []);
  regBySymbol.get(r.symbol).push(r);
}

const journalStatus = new Map();
for (const line of readFileSync(journalPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  try {
    const r = JSON.parse(line);
    journalStatus.set(r.symbol, r.status); // last write wins (same as sweep resume)
  } catch { /* torn line */ }
}

const candidates = parseCsv(candidatesPath).map((c) => ({
  symbol: c.symbol,
  date: c.ex_date,
  factor: Number(c.factor),
  ratioNew: c.ratio_new,
  ratioOld: c.ratio_old,
}));

const daysApart = (a, b) => Math.abs((new Date(a) - new Date(b)) / DAY_MS);

const report = ["row_kind,symbol,ex_date,classification,detail"];
const additions = ["symbol,ex_date,event,ratio_new,ratio_old,factor,source,confidence"];
const tally = {};

const bump = (k) => { tally[k] = (tally[k] ?? 0) + 1; };
const esc = (s) => (String(s).includes(",") ? `"${s}"` : s);

const matchedReg = new Set();
for (const c of candidates) {
  const regs = regBySymbol.get(c.symbol) ?? [];
  const m = regs.find((r) => daysApart(r.date, c.date) <= DATE_TOLERANCE_DAYS);
  if (m) {
    matchedReg.add(m);
    const dev = Math.abs(Math.log(c.factor / m.factor));
    if (dev <= FACTOR_LOG_TOL) {
      bump("confirmed");
      report.push(["candidate", c.symbol, c.date, "confirmed",
        `registry ${m.ratioNew}:${m.ratioOld} vs detected ${c.ratioNew}:${c.ratioOld}`].map(esc).join(","));
    } else {
      bump("confirmed-factor-mismatch");
      report.push(["candidate", c.symbol, c.date, "confirmed-factor-mismatch",
        `registry ${m.ratioNew}:${m.ratioOld} (${m.factor}) vs detected ${c.ratioNew}:${c.ratioOld} (${c.factor}) — trust registry factor, detector estimates from bars`].map(esc).join(","));
    }
    continue;
  }
  const st = journalStatus.get(c.symbol);
  let cls;
  if (st === undefined) cls = "out-of-scope-symbol";
  else if (st === "not-found") cls = "yahoo-blind-spot";
  else if (st === "ok") cls = "yahoo-missed";
  else cls = `journal-status-${st}`;
  bump(cls);
  report.push(["candidate", c.symbol, c.date, cls, `detected ${c.ratioNew}:${c.ratioOld} (${c.factor})`].map(esc).join(","));
  if (cls === "yahoo-missed" || cls === "yahoo-blind-spot") {
    additions.push([c.symbol, c.date, c.factor > 1 ? "FORWARD_SPLIT" : "REVERSE_SPLIT",
      c.ratioNew, c.ratioOld, String(c.factor), "inband", "estimated"].join(","));
  }
}

for (const r of registry) {
  if (matchedReg.has(r)) continue;
  const cls = r.factor >= BLIND_BAND[0] && r.factor <= BLIND_BAND[1] ? "expected-miss" : "detector-miss";
  bump(cls);
  report.push(["registry-event", r.symbol, r.date, cls,
    `yahoo ${r.ratioNew}:${r.ratioOld} (${r.factor}) not detected in-band`].map(esc).join(","));
}

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "split-crosscheck-report.csv"), report.join("\n") + "\n");
writeFileSync(path.join(outDir, "split-registry-additions.csv"), additions.join("\n") + "\n");

const nCand = candidates.length, nReg = registry.length;
console.log(`candidates: ${nCand} | registry events: ${nReg}`);
console.log(`tally: ${JSON.stringify(tally, null, 1)}`);
console.log(`gap rate (of answered symbols with detected events Yahoo missed): ` +
  `${tally["yahoo-missed"] ?? 0} candidate(s)`);
console.log(`proposed additions: ${additions.length - 1} -> split-registry-additions.csv`);
console.log(`full report -> split-crosscheck-report.csv`);
