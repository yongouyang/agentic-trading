/**
 * Weekly F10 corporate-action enrichment CLI (Phase-2 CA-source decision,
 * 2026-09-06, architecture §4) — scheduled, NON-BLOCKING: its failure never
 * degrades screen:daily (locked decision 3). Yahoo stays the primary CA event
 * source; eastmoney F10 (RPT_HKF10_MAIN_DIVBASIC, datacenter host — NOT the
 * ban-prone push2his; 12/12 calls at ~1s measured clean 2026-09-06, paced
 * ≥1s + jitter anyway) supplies:
 *
 *   1. IN_SPECIE import (all HK stocks): distributions-in-specie Yahoo never
 *      reports, upserted as CorporateAction type "IN_SPECIE" with
 *      amount = HKD-equivalent-per-share when published (else null) and
 *      detail = raw PLAN_EXPLAIN + parsed ratio. Price convention is
 *      unchanged: Yahoo closes are already net of in-specie, so these rows
 *      never feed local adjustment — they exist for audit and to bound the
 *      sentinel's eastmoney level window (sentinel-checks R3a note).
 *   2. Degraded overlay (CA_DEGRADED names — USD/RMB-declaring payers — plus
 *      names newly detected as non-HKD-declaring, which get caDegraded=true
 *      loudly): stored DIVIDEND amounts are overwritten with F10's HKD
 *      equivalent (HKD-native truth, no Yahoo FX round-trip).
 *   3. Non-degraded cross-check: F10 HKD amount vs stored DIVIDEND amount per
 *      ex-date, |dev| > 0.5% ⇒ warning only, no writes.
 *
 * US names and HK ETFs stay Yahoo-only (F10 has neither — measured): the
 * default lane is universe.hk.json kind === "stock"; an ETF passed via
 * --symbol gets F10's empty result and a no-op warning.
 *
 *   pnpm -C apps/api ca:f10-refresh [-- --symbol 0700.HK,0005.HK ...]
 *
 * Never throws on provider failure: per-name failures are collected and the
 * run continues; the final JSON report carries everything. Exit 0 unless
 * EVERY name failed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EastmoneyF10Provider, parseF10Plan, type F10DividendRow, type F10Provider } from "../market-data/eastmoney-f10.provider.js";
import { PrismaService } from "../prisma.service.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** Relative deviation above which a non-degraded amount mismatch is warned. */
export const CROSSCHECK_WARN_DEV = 0.005;

export interface StoredCaRow {
  date: string; // ex-date YYYY-MM-DD
  type: string; // "DIVIDEND" | "IN_SPECIE"
  amount: number | null;
  currency: string;
}

export interface CaWrite {
  date: string;
  type: "DIVIDEND" | "IN_SPECIE";
  amount: number | null;
  currency: string;
  /** Audit trail: raw PLAN_EXPLAIN (+ parsed ratio for in-specie). */
  detail: string;
}

export interface F10MergeResult {
  writes: CaWrite[];
  warnings: string[];
  /** True when an F10 cash row declares a non-HKD currency on a name not
   *  already flagged — caller sets Instrument.caDegraded (loud). */
  newlyDegraded: boolean;
}

const amountsDiffer = (a: number, b: number): boolean => Math.abs(a - b) > 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1);

/** Per-name merge of stored CA rows with fresh F10 rows — pure, so the whole
 *  decision table is unit-testable with plain objects. */
export function mergeF10ForSymbol(storedCas: StoredCaRow[], f10Rows: F10DividendRow[], caDegraded: boolean): F10MergeResult {
  const writes: CaWrite[] = [];
  const warnings: string[] = [];
  const cashRows: { row: F10DividendRow; hkd: number }[] = [];

  let newlyDegraded = false;
  const bonusExDates: string[] = [];
  for (const row of f10Rows) {
    const parsed = parseF10Plan(row.plan);
    if (parsed.kind === "in-specie") {
      if (!row.exDate) {
        warnings.push(`in-specie row without ex-date, skipped: "${row.plan}"`);
        continue;
      }
      writes.push({
        date: row.exDate,
        type: "IN_SPECIE",
        amount: parsed.hkdEquivalentPerShare,
        currency: parsed.hkdEquivalentPerShare != null ? "HKD" : "",
        detail: `${row.plan} [parsed ratio ${parsed.getShares}/${parsed.perShares} — ${parsed.asset}]`,
      });
    } else if (parsed.kind === "cash") {
      if (parsed.declaringCurrency !== "HKD" && !caDegraded) newlyDegraded = true;
      if (parsed.embeddedBonus && row.exDate) bonusExDates.push(row.exDate);
      const hkd = parsed.hkdEquivalent ?? (parsed.declaringCurrency === "HKD" ? parsed.declaringAmount : null);
      if (hkd != null) cashRows.push({ row, hkd });
      else if (parsed.declaringCurrency !== "HKD") warnings.push(`non-HKD cash row without HKD equivalent: "${row.plan}"`);
    } else if (parsed.kind === "bonus") {
      if (row.exDate) bonusExDates.push(row.exDate);
      warnings.push(`bonus/capitalization plan (split-class, out of scope): "${row.plan}"`);
    } else {
      warnings.push(`unparsed plan (kind=unknown): "${row.plan}"`);
    }
  }

  // One cash amount per ex-date: multiple F10 rows can share an ex-date
  // (measured 0005.HK 2024-05-09: 一季度分配 USD 0.10 + 特别分配 USD 0.21 —
  // the price drop on ex-date reflects the SUM, 2.420133 HKD).
  const cashByDate = new Map<string, { hkd: number; plans: string[] }>();
  for (const { row, hkd } of cashRows) {
    if (!row.exDate) continue;
    const agg = cashByDate.get(row.exDate) ?? { hkd: 0, plans: [] };
    agg.hkd += hkd;
    agg.plans.push(row.plan);
    cashByDate.set(row.exDate, agg);
  }
  const cashEvents = [...cashByDate.entries()].map(([exDate, a]) => ({ exDate, hkd: a.hkd, detail: a.plans.join(" | ") }));

  const degraded = caDegraded || newlyDegraded;
  const storedDividends = new Map(storedCas.filter((c) => c.type === "DIVIDEND").map((c) => [c.date, c]));
  const f10CashDates = new Set(cashEvents.map((c) => c.exDate));

  // Share-terms guard (measured live 2026-09-06 on 1211.HK): F10 cash amounts
  // are AS-DECLARED — across a bonus/capitalization event (split-class) they
  // sit in pre-split share terms while stored Yahoo amounts are split-adjusted
  // (1211.HK: F10 4.33596 vs stored 1.44532 = exactly the 3:1 of 2025-06-10,
  // and the bonus clause is EMBEDDED in that cash row's plan). Overlaying
  // across that boundary would corrupt the store, so BOTH the overlay and the
  // cross-check only touch ex-dates after the latest bonus.
  const bonusCutoff = bonusExDates.length ? [...bonusExDates].sort().at(-1)! : null;
  const overlayable = bonusCutoff ? cashEvents.filter((c) => c.exDate > bonusCutoff) : cashEvents;
  if (bonusCutoff && cashEvents.length !== overlayable.length) {
    warnings.push(
      `bonus/capitalization event at ${bonusCutoff}: F10 cash amounts on or before it are as-declared (pre-split share terms) — overlay/cross-check restricted to later ex-dates`,
    );
  }

  if (degraded) {
    // Overlay: F10's HKD equivalent is the truth for names whose Yahoo
    // amounts are FX-converted (architecture §4).
    for (const { exDate, hkd, detail } of overlayable) {
      const stored = storedDividends.get(exDate);
      if (!stored) {
        warnings.push(`F10 cash ex-date ${exDate} (HKD ${hkd}) has no stored DIVIDEND row — no write ("${detail}")`);
        continue;
      }
      if (stored.amount != null && !amountsDiffer(stored.amount, hkd)) continue;
      writes.push({
        date: exDate,
        type: "DIVIDEND",
        amount: hkd,
        currency: "HKD",
        detail,
      });
      warnings.push(`overlay: ${exDate} DIVIDEND amount ${stored.amount ?? "null"} ${stored.currency} → ${hkd} HKD (F10 corrected)`);
    }
    for (const date of storedDividends.keys()) {
      if (!f10CashDates.has(date)) warnings.push(`stored DIVIDEND ex-date ${date} has no F10 cash row — left as-is`);
    }
  } else {
    // Cross-check only, no writes: F10 is the second opinion on HKD-native names.
    for (const { exDate, hkd } of overlayable) {
      const stored = storedDividends.get(exDate);
      if (!stored || stored.amount == null || stored.amount === 0) continue;
      const dev = Math.abs(hkd / stored.amount - 1);
      if (dev > CROSSCHECK_WARN_DEV) {
        warnings.push(
          `cross-check: ${exDate} stored ${stored.amount} ${stored.currency} vs F10 HKD ${hkd} deviates ${(dev * 100).toFixed(2)}% (> 0.5%) — no write (not CA_DEGRADED)`,
        );
      }
    }
  }

  return { writes, warnings, newlyDegraded };
}

// ---------------------------------------------------------------------------
// Runner (I/O shell around mergeF10ForSymbol).
// ---------------------------------------------------------------------------

export interface RefreshF10Deps {
  prisma: PrismaService;
  provider: F10Provider;
  /** --symbol subset (default: all universe.hk.json kind === "stock"). */
  symbols?: string[];
  /** Universe data dir (default apps/api/data). */
  dataDir?: string;
  /** stdout sink (default console.log). */
  log?: (line: string) => void;
}

export interface RefreshF10Report {
  ok: boolean;
  names: number;
  failed: { symbol: string; failure: string }[];
  inSpecieUpserted: number;
  overlayCorrected: number;
  newlyDegraded: string[];
  warnings: string[];
}

export function hkStockUniverse(dataDir: string): string[] {
  const raw = JSON.parse(readFileSync(path.join(dataDir, "universe.hk.json"), "utf8"));
  return (raw.symbols as { symbol: string; kind: string }[]).filter((e) => e.kind === "stock").map((e) => e.symbol);
}

export async function runF10Refresh(deps: RefreshF10Deps): Promise<RefreshF10Report> {
  const { prisma, provider } = deps;
  const log = deps.log ?? console.log;
  const symbols = deps.symbols ?? hkStockUniverse(deps.dataDir ?? path.join(PKG_ROOT, "data"));
  const report: RefreshF10Report = { ok: false, names: symbols.length, failed: [], inSpecieUpserted: 0, overlayCorrected: 0, newlyDegraded: [], warnings: [] };

  for (const symbol of symbols) {
    const instrument = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) {
      report.warnings.push(`${symbol}: no Instrument row — run screen:daily first, skipped`);
      log(`${symbol}: WARN not in store, skipped`);
      continue;
    }
    const res = await provider.fetchDividendRows(symbol);
    if ("failure" in res) {
      report.failed.push({ symbol, failure: res.failure });
      log(`${symbol}: FAILED ${res.failure}`);
      continue;
    }
    if (!res.rows.length) {
      report.warnings.push(`${symbol}: no F10 dividend rows (ETF has no F10 records, or a genuine non-payer — measured: 01810)`);
      log(`${symbol}: 0 F10 rows, no-op`);
      continue;
    }
    const storedCas = await prisma.corporateAction.findMany({ where: { instrumentId: instrument.id }, orderBy: { date: "asc" } });
    const merge = mergeF10ForSymbol(storedCas, res.rows, instrument.caDegraded);

    for (const w of merge.writes) {
      await prisma.corporateAction.upsert({
        where: { instrumentId_date_type: { instrumentId: instrument.id, date: w.date, type: w.type } },
        create: { instrumentId: instrument.id, date: w.date, type: w.type, amount: w.amount, currency: w.currency, detail: w.detail },
        update: { amount: w.amount, currency: w.currency, detail: w.detail },
      });
      if (w.type === "IN_SPECIE") report.inSpecieUpserted++;
      else report.overlayCorrected++;
    }
    if (merge.newlyDegraded) {
      await prisma.instrument.update({ where: { id: instrument.id }, data: { caDegraded: true } });
      report.newlyDegraded.push(symbol);
      report.warnings.push(`${symbol}: NEWLY CA_DEGRADED — F10 declares a non-HKD dividend currency (caDegraded set, overlay applied this run)`);
    }
    for (const w of merge.warnings) report.warnings.push(`${symbol}: ${w}`);
    log(
      `${symbol}: ${res.rows.length} F10 rows → ${merge.writes.filter((w) => w.type === "IN_SPECIE").length} in-specie, ` +
        `${merge.writes.filter((w) => w.type === "DIVIDEND").length} overlay, ${merge.warnings.length} warnings` +
        `${merge.newlyDegraded ? " · NEWLY CA_DEGRADED" : ""}`,
    );
  }

  report.ok = report.failed.length < symbols.length;
  log(JSON.stringify(report, null, 2));
  return report;
}

// ---------------------------------------------------------------------------
// CLI wrapper (argument parsing + wiring only).
// ---------------------------------------------------------------------------

export function parseRefreshF10Args(argv: string[]): { symbols?: string[] } {
  const symbols: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // pnpm injects a bare "--" before the script's own args — skip it.
    if (arg === "--") continue;
    if (arg === "--symbol") {
      const value = argv[++i];
      if (!value) throw new Error("--symbol needs a value (e.g. --symbol 0700.HK,0005.HK)");
      symbols.push(...value.split(",").filter(Boolean));
    } else throw new Error(`unknown argument "${arg}" (expected --symbol)`);
  }
  return symbols.length ? { symbols } : {};
}

async function main(): Promise<void> {
  const args = parseRefreshF10Args(process.argv.slice(2));
  const prisma = new PrismaService();
  await prisma.$connect();
  let ok = false;
  try {
    const report = await runF10Refresh({ prisma, provider: new EastmoneyF10Provider(), ...args });
    ok = report.ok;
  } finally {
    await prisma.$disconnect();
  }
  if (!ok) process.exitCode = 1;
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}
