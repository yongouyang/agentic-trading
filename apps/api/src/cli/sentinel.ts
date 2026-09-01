/**
 * Weekly sentinel CLI (phase-1-hardening-plan §B) — the architecture §4.3
 * insurance against a provider silently rewriting history. Not optional;
 * manual cadence in v1 (roughly weekly, no scheduler).
 *
 *   pnpm -C apps/api screen:sentinel [--eastmoney] [--symbol 0005.HK ...]
 *
 * Plain script, NOT Nest (same shape as cli/daily-screen.ts): constructs
 * PrismaService + the env-selected Yahoo provider + MarketDataService and
 * calls runSentinel(), which tests drive directly with fakes.
 *
 * Read-only by design: it never writes bars, CAs or runs — only the JSON
 * artifact in apps/api/reports/sentinel-<date>.json (the diff baseline for
 * future runs) and the exit code.
 *
 * Three fetch legs per name (10 names ≈ 1–2 min):
 *   1. Yahoo fresh full window  → checkYahooRewrite (ALARM on any mismatch)
 *                                + checkCaRevision (WARN on event delta)
 *   2. tencent session dates    → checkTencentDates (dates only; tencent has
 *                                no raw HK series, so closes are never fetched)
 *   3. eastmoney raw closes     → checkEastmoneyRaw. OFF by default:
 *                                eastmoney's IP ban (measured 2026-08-31, still
 *                                live 2026-09-02) means every sentinel run
 *                                would probe — and potentially extend — the ban.
 *                                Pass --eastmoney (or inject a provider) to
 *                                enable the leg; it then paces itself at ≥2s.
 *
 * Exit code: 0 unless at least one ALARM (then 1) so cron can wire it up
 * without changes. A FATAL error also exits 1 with the error printed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Bar } from "@agentic-trading/quant-core";
import { DataOutcome, HKEX_KNOWN_NON_SESSIONS } from "@agentic-trading/quant-core";
import { getMarketDataDeps } from "../market-data/market-data.deps.js";
import { isDummyProviderLabel } from "./daily-screen.js";
import { EastmoneyRepairProvider, type RepairProvider } from "../market-data/eastmoney-repair.provider.js";
import { MarketDataService } from "../market-data/market-data.service.js";
import type { MarketDataProvider } from "../market-data/market-data.types.js";
import { TencentKlineProvider, type TencentDateSource } from "../market-data/tencent.provider.js";
import { PrismaService } from "../prisma.service.js";
import {
  checkCaRevision,
  checkEastmoneyRaw,
  checkTencentDates,
  checkYahooRewrite,
  overlapWindow,
  worstStatus,
  type CaEvent,
  type SentinelCheck,
  type SentinelCheckName,
  type SentinelStatus,
} from "../sentinel/sentinel-checks.js";
import { SENTINEL_HK_SAMPLE } from "../sentinel/sentinel-sample.js";

export interface SentinelDeps {
  prisma: PrismaService;
  /** Fresh-Yahoo leg (real provider or dummy/fake in tests). */
  provider: MarketDataProvider;
  /** Tencent date leg. Undefined ⇒ default: real provider, or disabled under
   *  MARKET_DATA_TEST_MODE=1 (fail-closed: tests always inject a fake). */
  tencent?: TencentDateSource | null;
  /** Eastmoney raw leg. Undefined ⇒ disabled (the banned leg is opt-in:
   *  `--eastmoney`, or inject a provider in tests). Explicit object enables. */
  eastmoney?: RepairProvider | null;
  /** Sample override (tests / single-name diagnosis). Default: pinned list. */
  symbols?: string[];
  /** Known-closure set for the tencent phantom-date attribution (test
   *  override). Default: HKEX_KNOWN_NON_SESSIONS (published + ad-hoc). */
  knownNonSessions?: ReadonlySet<string>;
  /** Report date YYYY-MM-DD (default today) — deterministic in tests. */
  today?: string;
  /** stdout sink (default console.log). */
  log?: (line: string) => void;
  /** Report directory (default apps/api/reports). Null disables the artifact. */
  reportsDir?: string | null;
  /** Provider label echoed in the report (same guard as the daily header: a
   *  sentinel run through the dummy compares synthetic against synthetic and
   *  proves nothing). Undefined ⇒ derived from the injected provider's class. */
  providerLabel?: string;
}

export interface SentinelOpts {
  /** Enable the eastmoney cross-source leg (banned host — opt-in). */
  eastmoney?: boolean;
}

export interface SentinelRow {
  symbol: string;
  /** Instrument.dataSource as stored ("yahoo" | "eastmoney"), null when the
   *  symbol is not in the store at all. */
  storedSource: string | null;
  storedBars: number;
  verdict: SentinelStatus;
  checks: SentinelCheck[];
}

export interface SentinelReport {
  date: string;
  sample: string[];
  /** True when the run used a `--symbol` override instead of the pinned list. */
  customSample: boolean;
  legs: { yahoo: string; tencent: string; eastmoney: string };
  rows: SentinelRow[];
  counts: Record<SentinelStatus, number>;
  /** True when any row is ALARM ⇒ exit code 1. */
  alarm: boolean;
  text: string;
}

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

const CHECK_ORDER: SentinelCheckName[] = ["yahoo-rewrite", "eastmoney-raw", "tencent-dates", "ca-revision"];
const CELL_WIDTH = 34;

function skip(check: SentinelCheckName, summary: string, detail: string): SentinelCheck {
  return { check, status: "skip", summary, metrics: {}, details: [detail] };
}

function pad(cell: string): string {
  return cell.length > CELL_WIDTH ? `${cell.slice(0, CELL_WIDTH - 1)}…` : cell.padEnd(CELL_WIDTH);
}

function renderTable(report: Omit<SentinelReport, "text">): string {
  const head = `${"symbol".padEnd(9)}${"stored".padStart(6)}  ${CHECK_ORDER.map((c) => pad(c)).join("")} verdict`;
  const lines = report.rows.map((row) => {
    const cells = CHECK_ORDER.map((name) => pad(row.checks.find((c) => c.check === name)?.summary ?? "—"));
    return (
      `${row.symbol.padEnd(9)}${String(row.storedBars).padStart(6)}  ${cells.join(" ")}` +
      ` ${row.verdict.toUpperCase()}${row.storedSource === "eastmoney" ? " (store=eastmoney)" : ""}`
    );
  });
  const legs = `legs: yahoo=${report.legs.yahoo} · tencent=${report.legs.tencent} · eastmoney=${report.legs.eastmoney}`;
  return [
    `== SENTINEL ==  ${report.date} · sample ${report.sample.length} HK names${report.customSample ? " (CUSTOM --symbol override)" : ""} · ` +
      `ALARM: ${report.counts.alarm} · WARN: ${report.counts.warn} · ok: ${report.counts.ok} · skip: ${report.counts.skip} · ` +
      `exit: ${report.alarm ? 1 : 0}`,
    `  ${legs}`,
    head,
    ...lines,
    ...report.rows
      .filter((r) => r.verdict === "alarm" || r.verdict === "warn")
      .flatMap((r) =>
        r.checks
          .filter((c) => c.status === "alarm" || c.status === "warn")
          .flatMap((c) => [`${r.symbol} [${c.check}] ${c.status.toUpperCase()}: ${c.details.join(" | ") || c.summary}`]),
      ),
  ].join("\n");
}

async function runSymbol(
  symbol: string,
  deps: SentinelDeps,
  service: MarketDataService,
  tencent: TencentDateSource | null,
  eastmoney: RepairProvider | null,
): Promise<SentinelRow> {
  const { prisma } = deps;
  const instrument = await prisma.instrument.findUnique({ where: { symbol } });
  if (!instrument) {
    // Loud on purpose: a sentinel that silently skips an unmonitored name is
    // the failure mode this whole workstream exists to prevent.
    return {
      symbol,
      storedSource: null,
      storedBars: 0,
      verdict: "warn",
      checks: [
        {
          check: "yahoo-rewrite",
          status: "warn",
          summary: "WARN not-in-store",
          metrics: {},
          details: [`${symbol} has no Instrument row — run screen:daily before the sentinel (nothing to diff)`],
        },
        skip("eastmoney-raw", "skip", "not in store"),
        skip("tencent-dates", "skip", "not in store"),
        skip("ca-revision", "skip", "not in store"),
      ],
    };
  }

  const storedBars = (await prisma.bar.findMany({ where: { instrumentId: instrument.id }, orderBy: { date: "asc" } })).map<Bar>(
    (b) => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }),
  );
  const storedCas = await prisma.corporateAction.findMany({
    where: { instrumentId: instrument.id, type: "DIVIDEND" },
    orderBy: { date: "asc" },
  });

  if (!storedBars.length) {
    return {
      symbol,
      storedSource: instrument.dataSource,
      storedBars: 0,
      verdict: "warn",
      checks: [
        { check: "yahoo-rewrite", status: "warn", summary: "WARN empty-store", metrics: {}, details: ["no stored bars to compare — run screen:daily"] },
        skip("eastmoney-raw", "skip", "empty store"),
        skip("tencent-dates", "skip", "empty store"),
        skip("ca-revision", "skip", "empty store"),
      ],
    };
  }

  // ---- leg 1: fresh Yahoo (full default window, loader repairs applied) ----
  const fresh = await service.getDailyBars(symbol);
  const freshOk = fresh.outcome === DataOutcome.OK;
  const reference = freshOk && fresh.bars.length ? fresh.bars : storedBars;

  const yahooCheck: SentinelCheck = freshOk
    ? checkYahooRewrite(storedBars, fresh.bars, instrument.dataSource)
    : fresh.outcome === DataOutcome.GENUINELY_ABSENT
      ? {
          check: "yahoo-rewrite",
          status: "alarm",
          summary: "ALARM absent-now",
          metrics: { storedBars: storedBars.length, outcome: fresh.outcome },
          details: [`Yahoo now answers GENUINELY_ABSENT for ${symbol} (${fresh.failureReason ?? "no reason"}) — a pinned liquid sample name should never disappear (source-scoped: it may still exist elsewhere)`],
        }
      : {
          check: "yahoo-rewrite",
          status: "warn",
          summary: `WARN fetch-${fresh.failureReason ?? "failed"}`,
          metrics: { storedBars: storedBars.length, outcome: fresh.outcome },
          details: [`fresh Yahoo fetch ${fresh.outcome} (${fresh.failureReason ?? "no reason"}) — rewrite check skipped, cross-source legs compare against the STORED series`],
        };

  // ---- leg 2: tencent session dates (never closes) ----
  const tencentCheck: SentinelCheck = !tencent
    ? skip("tencent-dates", "skip disabled", "tencent leg disabled (test mode or explicitly off) — no second-calendar check this run")
    : await (async () => {
        const res = await tencent.fetchSessionDates(symbol);
        if ("failure" in res) {
          // Tencent fragility is a known fact (silent-empty 200s); skipping is
          // honest, alarming is noise. The reason is recorded loudly.
          return skip("tencent-dates", `skip ${res.failure}`.slice(0, CELL_WIDTH), `tencent fetch failed: ${res.failure}`);
        }
        return checkTencentDates(reference.map((b) => b.date), res.dates, deps.knownNonSessions ?? HKEX_KNOWN_NON_SESSIONS);
      })();

  // ---- leg 3: eastmoney raw closes (opt-in, banned host) ----
  const eastmoneyCheck: SentinelCheck = !eastmoney
    ? skip("eastmoney-raw", "skip disabled", "eastmoney leg not enabled — pass --eastmoney (host is IP-ban prone)")
    : await (async () => {
        const res = await eastmoney.fetchRawBars(symbol);
        if ("failure" in res) return skip("eastmoney-raw", `skip ${res.failure}`.slice(0, CELL_WIDTH), `eastmoney fetch failed: ${res.failure}`);
        return checkEastmoneyRaw(storedBars, res.bars);
      })();

  // ---- leg 4: CA revision (needs a fresh Yahoo event set) ----
  const storedEvents: CaEvent[] = storedCas.map((c) => ({ date: c.date, amount: c.amount }));
  const freshEvents: CaEvent[] = freshOk ? fresh.corporateActions.map((c) => ({ date: c.date, amount: c.amount })) : [];
  const caWindow = freshOk ? overlapWindow(storedBars.map((b) => b.date).sort(), fresh.bars.map((b) => b.date).sort()) ?? undefined : undefined;
  const caCheck: SentinelCheck = freshOk
    ? checkCaRevision(storedEvents, freshEvents, caWindow, { ignoreAmounts: instrument.caDegraded })
    : skip("ca-revision", "skip no-fetch", "no fresh Yahoo event set (fetch did not succeed)");

  const checks = [yahooCheck, eastmoneyCheck, tencentCheck, caCheck];
  return {
    symbol,
    storedSource: instrument.dataSource,
    storedBars: storedBars.length,
    verdict: worstStatus(checks.map((c) => c.status)),
    checks,
  };
}

/** The runner tests call directly (no child processes, no network under
 *  injected fakes). */
export async function runSentinel(deps: SentinelDeps, opts: SentinelOpts = {}): Promise<SentinelReport> {
  const today = deps.today ?? new Date().toISOString().slice(0, 10);
  const log = deps.log ?? console.log;
  const symbols = deps.symbols ?? [...SENTINEL_HK_SAMPLE];
  const service = new MarketDataService({ provider: deps.provider, testMode: false, dummyMode: false });

  const tencent =
    deps.tencent !== undefined ? deps.tencent : process.env.MARKET_DATA_TEST_MODE === "1" ? null : new TencentKlineProvider();
  // Fail-closed on the banned host: only --eastmoney (or an injected provider)
  // turns this leg on.
  const eastmoney =
    deps.eastmoney !== undefined ? deps.eastmoney : opts.eastmoney ? new EastmoneyRepairProvider() : null;

  const rows: SentinelRow[] = [];
  for (const symbol of symbols) rows.push(await runSymbol(symbol, deps, service, tencent, eastmoney));

  const customSample = symbols.length !== SENTINEL_HK_SAMPLE.length || symbols.some((s) => !SENTINEL_HK_SAMPLE.includes(s));
  const counts: Record<SentinelStatus, number> = { ok: 0, warn: 0, alarm: 0, skip: 0 };
  for (const row of rows) counts[row.verdict]++;

  const providerLabel = deps.providerLabel ?? deps.provider.constructor.name;
  const synthetic = isDummyProviderLabel(providerLabel) ? " ⚠ SYNTHETIC, proves nothing" : "";
  const partial: Omit<SentinelReport, "text"> = {
    date: today,
    sample: symbols,
    customSample,
    legs: {
      yahoo: `fresh 5y (${providerLabel}${synthetic})`,
      tencent: tencent ? "enabled" : "disabled",
      eastmoney: eastmoney ? "enabled" : "disabled (opt-in via --eastmoney)",
    },
    rows,
    counts,
    alarm: counts.alarm > 0,
  };
  const report: SentinelReport = { ...partial, text: renderTable(partial) };

  log(report.text);
  if (deps.reportsDir !== null) {
    const dir = deps.reportsDir ?? path.join(PKG_ROOT, "reports");
    mkdirSync(dir, { recursive: true });
    const { text: _text, ...json } = report;
    writeFileSync(path.join(dir, `sentinel-${today}.json`), JSON.stringify(json, null, 2));
  }
  return report;
}

// ---------------------------------------------------------------------------
// CLI wrapper (argument parsing + env wiring only).
// ---------------------------------------------------------------------------

export interface SentinelArgs {
  eastmoney: boolean;
  symbols?: string[];
}

export function parseSentinelArgs(argv: string[]): SentinelArgs {
  const out: SentinelArgs = { eastmoney: false };
  const symbols: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // pnpm injects a bare "--" before the script's own args
    // (`pnpm -C apps/api screen:sentinel -- --eastmoney`) — skip the separator.
    if (arg === "--") continue;
    if (arg === "--eastmoney") out.eastmoney = true;
    else if (arg === "--symbol") {
      const value = argv[++i];
      if (!value) throw new Error("--symbol needs a value (e.g. --symbol 0005.HK)");
      symbols.push(value);
    } else throw new Error(`unknown argument "${arg}" (expected --eastmoney or --symbol)`);
  }
  if (symbols.length) out.symbols = symbols;
  return out;
}

async function main(): Promise<void> {
  const args = parseSentinelArgs(process.argv.slice(2));
  const prisma = new PrismaService();
  await prisma.$connect();
  let alarm = false;
  try {
    const { provider, dummyMode } = getMarketDataDeps(process.env);
    // args.symbols is a CLI-level override: thread it into the runner's deps.
    const report = await runSentinel(
      { prisma, provider, providerLabel: dummyMode ? "dummy" : "yahoo", ...(args.symbols ? { symbols: args.symbols } : {}) },
      { eastmoney: args.eastmoney },
    );
    alarm = report.alarm;
  } finally {
    await prisma.$disconnect();
  }
  if (alarm) process.exitCode = 1;
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}
