/**
 * `report:cost` — charter K3's spend read, in full (2026-09-16; phases 1/2/4/5
 * built the measurement, this is the report).
 *
 * READ-ONLY. Nothing is written to any store table. Answers three questions and
 * refuses to guess at any of them:
 *
 *   1. The K3 gate — month-to-date spend against the agreed cap, on a price basis
 *      that is printed with the number (a dollar figure without its basis is not
 *      reproducible once prices move).
 *   2. Unit economics — tokens and dollars per name, per lane and pooled, so a
 *      breadth change has a price. Phase 5's own note calls widening the
 *      deep-dive "a token-cost decision, not a time decision"; this is the cost
 *      half of that sentence, and it is the price tag on HK's open breadth
 *      question.
 *   3. Where the money goes — per role (chat broken out from the pipeline), per
 *      model (so a model switch is visible in money, not just in provenance),
 *      and the cache discount actually earned (`naive` vs `measured`, which is
 *      also the only place a prompt-builder change that breaks prefix reuse would
 *      show up as a silent cost doubling).
 *
 * Attribution is first-use (see `ops/cost.ts`), so the per-run rows RECONCILE
 * with the month total; anything the runs do not own — chat, and decisions no run
 * references — is reported as such rather than smeared across the table.
 *
 *   pnpm -C apps/api report:cost [-- --month YYYY-MM] [--json]
 *
 * Exit code is 0 even when spend is over cap: the cap is a discipline signal, and
 * `ops:health` already carries the same fact informationally. A cron alert can
 * read `overCap` from `--json` (or from reports/cost-<month>.json) if wanted.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hktMonthStart } from "../ops/health.js";
import {
  loadCostRows,
  loadRunCosts,
  loadRunRefs,
  parseCapUsd,
  parsePricing,
  summarize,
  type CostSummary,
  type CostTotals,
  type RunCost,
} from "../ops/cost.js";
import { PrismaService } from "../prisma.service.js";
import { loadEnvFiles } from "./deep-dive.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export interface CostReport {
  month: string;
  generatedAt: string;
  priced: boolean;
  basis: string | null;
  capUsd: number | null;
  overCap: boolean;
  totals: CostTotals;
  cacheHitRate: number | null;
  byAgent: Record<string, CostTotals>;
  byModel: Record<string, CostTotals>;
  /** Chain and ad-hoc runs inside the month, in time order. */
  runs: RunCost[];
  /** Month spend the runs do not own: chat turns, and decisions no run references.
   *  Non-zero in practice even with perfect attribution, and honestly so: the
   *  40 k3 decisions created 2026-09-10 08:35-08:37 HKT belong to no run row at
   *  all — a deep-dive killed mid-flight BEFORE W2 started writing the run row
   *  first, which is precisely the failure mode W2 exists to stop. They were
   *  billed, so they belong in the month total; no run can claim them. */
  unattributedUsd: number;
  perName: { pooled: number | null; HK: number | null; US: number | null };
  /** The breadth price tag: what N more names per lane-night would cost, using
   *  the measured per-name figure for the lane that is being widened. */
  breadth: { addedNamesPerLane: number; perNightUsd: number | null; perMonthUsd: number | null; nightsPerMonth: number } | null;
}

export interface CostReportDeps {
  prisma: PrismaService;
  /** Directory for cost-<month>.json; null skips the artifact. */
  reportsDir: string | null;
  now?: Date;
  /** `YYYY-MM`, HKT. Defaults to the month containing `now`. */
  month?: string;
  log?: (line: string) => void;
}

const usd = (v: number | null) => (v == null ? "—" : `$${v.toFixed(4)}`);
const usd2 = (v: number | null) => (v == null ? "—" : `$${v.toFixed(2)}`);
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${(n / 1e3).toFixed(1)}k`);
const hktDate = (d: Date) => new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);

/** HKT month window `[start, end)` for a `YYYY-MM` label. */
export function monthWindow(month: string): { since: Date; until: Date } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  // hktSlot is private to ops/health; reconstruct from the HKT offset directly
  // rather than duplicating a calendar: HKT midnight == 16:00 UTC the day before.
  const since = new Date(Date.UTC(y, m - 1, 1, 0, 0) - 8 * 3600 * 1000);
  const until = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 0, 0) - 8 * 3600 * 1000);
  return { since, until };
}

const NIGHTS_PER_MONTH = 30 * (5 / 7); // the chain runs on weekdays; a month holds ~21.4

export async function runCostReport(deps: CostReportDeps): Promise<CostReport> {
  const { prisma } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const now = deps.now ?? new Date();
  const month = deps.month ?? hktMonthStart(now).month;
  const { since, until } = monthWindow(month);
  const pricing = parsePricing(process.env);
  const capUsd = parseCapUsd(process.env);

  const rows = await loadCostRows(prisma, since, until);
  const summary: CostSummary = summarize(rows, pricing, capUsd);

  // Ownership spans all history (see loadRunRefs); only the month's runs are shown.
  const refs = await loadRunRefs(prisma, until);
  const priced = await loadRunCosts(prisma, refs, pricing);
  const runs = priced.filter((r) => r.runAt >= since);

  // Per-name figures, derived from the runs we actually paid for. A lane-night's
  // names are comparable only within a lane (HK and US carry different context).
  const perNameOf = (list: RunCost[]): number | null => {
    const names = list.reduce((a, r) => a + r.names, 0);
    if (names === 0 || !summary.priced) return null;
    return list.reduce((a, r) => a + r.usd, 0) / names;
  };
  const chainRuns = runs.filter((r) => r.source === "chain");
  const perName = {
    pooled: perNameOf(chainRuns),
    HK: perNameOf(chainRuns.filter((r) => r.market === "HK")),
    US: perNameOf(chainRuns.filter((r) => r.market === "US")),
  };

  const runsUsd = runs.reduce((a, r) => a + r.usd, 0);
  const addedNamesPerLane = 20; // the concrete question HK's breadth asks: 40 -> 60
  const bothLanes = perName.HK != null && perName.US != null ? perName.HK + perName.US : null;
  const breadth =
    bothLanes == null
      ? null
      : {
          addedNamesPerLane,
          perNightUsd: bothLanes * addedNamesPerLane,
          perMonthUsd: bothLanes * addedNamesPerLane * NIGHTS_PER_MONTH,
          nightsPerMonth: Math.round(NIGHTS_PER_MONTH),
        };

  const report: CostReport = {
    month,
    generatedAt: now.toISOString(),
    priced: summary.priced,
    basis: summary.basis,
    capUsd: summary.priced ? summary.capUsd : null,
    overCap: summary.overCap,
    totals: summary.totals,
    cacheHitRate: summary.cacheHitRate,
    byAgent: summary.byAgent,
    byModel: summary.byModel,
    runs,
    unattributedUsd: summary.priced ? summary.totals.usd - runsUsd : 0,
    perName,
    breadth,
  };

  let artifactPath: string | null = null;
  if (deps.reportsDir) {
    mkdirSync(deps.reportsDir, { recursive: true });
    artifactPath = path.join(deps.reportsDir, `cost-${month}.json`);
    writeFileSync(artifactPath, JSON.stringify(report, null, 2));
  }
  for (const line of formatCostReport(report, artifactPath)) log(line);
  return report;
}

export function formatCostReport(r: CostReport, artifactPath: string | null = null): string[] {
  const lines: string[] = [];
  const t = r.totals;
  // With no prices there is no dollar figure to print — and printing `$0.00`
  // would not be "no data", it would be a WRONG number (spend happened, it just
  // cannot be priced). Every money column degrades to an em dash instead.
  const money = (v: number) => (r.priced ? usd2(v) : "—");

  const cap = r.capUsd != null ? ` of $${r.capUsd.toFixed(2)} cap` : " (no cap set)";
  lines.push(`== COST == ${r.month} (HKT) · ${r.priced ? `${usd2(t.usd)}${cap}` : "UNPRICED (no LLM_PRICE_* configured)"} · ${t.calls} calls · ${tok(t.promptTokens)} in / ${tok(t.completionTokens)} out`);
  if (!r.priced) {
    lines.push(`    prices not configured — tokens only. Set ${"LLM_PRICE_INPUT_PER_MTOK"} / ${"LLM_PRICE_OUTPUT_PER_MTOK"} (/ peak + cache-hit) in .env`);
  } else {
    lines.push(`    basis: ${r.basis ?? "—"}`);
    if (r.cacheHitRate != null) {
      lines.push(`    cache: ${(r.cacheHitRate * 100).toFixed(0)}% of input served from cache · measured ${usd2(t.usd)} vs no-cache ${usd2(t.naiveUsd)} (saved ${usd2(t.naiveUsd - t.usd)})`);
    } else {
      lines.push(`    cache: no row carries the split yet (capture landed 2026-09-16) — the discount becomes visible from the next chain run`);
    }
    lines.push(`    tiers: off-peak ${t.offPeakCalls} calls · peak ${t.peakCalls}${t.tierUnpriced > 0 ? ` (${t.tierUnpriced} PEAK rows priced off-peak — no peak prices configured, spend understated)` : ""}`);
    if (t.upperBound) lines.push(`    UPPER BOUND: some rows predate cache-split capture (2026-09-16)`);
    if (t.unpricedCalls > 0) lines.push(`    ${t.unpricedCalls} call(s) had no readable usage blob — their tokens are missing from these totals`);
    if (r.overCap) lines.push(`    OVER CAP by ${usd2(t.usd - (r.capUsd ?? 0))} — informational, exit code stays 0 (K3 is a discipline gate, not a data-integrity failure)`);
  }

  lines.push(`  runs (chain + ad-hoc, first-use attribution so these reconcile with the month total):`);
  if (r.runs.length === 0) lines.push(`    none in ${r.month}`);
  for (const run of r.runs) {
    const name = `${run.market} ${hktDate(run.runAt)} #${run.runId}${run.source === "chain" ? "" : " adhoc"}`;
    const per = run.names > 0 && r.priced ? usd(run.usd / run.names) : "—";
    lines.push(
      `    ${name.padEnd(22)} names ${String(run.decidedNames).padStart(2)}/${String(run.names).padEnd(2)} · ${String(run.calls).padStart(3)} calls · ${tok(run.promptTokens).padStart(7)} in · ${money(run.usd).padStart(8)} · ${per}/name` +
        `${run.replayed > 0 ? ` · ${run.replayed} replayed from cache (free)` : ""}`,
    );
  }
  if (r.priced) lines.push(`    other (chat + decisions no run owns): ${usd2(r.unattributedUsd)}`);

  lines.push(`  by role:`);
  for (const [agent, a] of Object.entries(r.byAgent).sort((x, y) => y[1].usd - x[1].usd)) {
    lines.push(`    ${agent.padEnd(22)} ${String(a.calls).padStart(3)} calls · ${tok(a.promptTokens).padStart(7)} in / ${tok(a.completionTokens).padStart(6)} out · ${money(a.usd)}`);
  }
  const models = Object.entries(r.byModel);
  if (models.length > 1) {
    lines.push(`  by model: ${models.map(([m, v]) => `${m} ${v.calls}`).join(" · ")}`);
  }

  const chainRuns = r.runs.filter((run) => run.source === "chain");
  const chainNames = chainRuns.reduce((a, x) => a + x.names, 0);
  if (r.priced && r.perName.pooled != null && chainNames > 0) {
    const inPerName = Math.round(chainRuns.reduce((a, x) => a + x.promptTokens, 0) / chainNames);
    const outPerName = Math.round(chainRuns.reduce((a, x) => a + x.completionTokens, 0) / chainNames);
    lines.push(
      `  per name (chain runs only): ${usd(r.perName.pooled)} pooled · HK ${usd(r.perName.HK)} · US ${usd(r.perName.US)}` +
        ` · ${inPerName.toLocaleString("en-US")} in / ${outPerName.toLocaleString("en-US")} out tokens`,
    );
  }
  if (r.breadth && r.breadth.perMonthUsd != null) {
    lines.push(
      `  breadth: +${r.breadth.addedNamesPerLane} names/lane/night ≈ ${usd2(r.breadth.perNightUsd)}/night, ${usd2(r.breadth.perMonthUsd)}/month at ${r.breadth.nightsPerMonth} nights (the price of the HK breadth question)`,
    );
  }
  if (artifactPath) lines.push(`artifact: ${artifactPath}`);
  return lines;
}

interface CostArgs {
  month?: string;
  json: boolean;
}

export function parseCostArgs(argv: string[]): CostArgs {
  const out: CostArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue; // pnpm injects a bare "--"
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg === "--month") {
      const v = argv[++i];
      if (!v || !/^\d{4}-\d{2}$/.test(v)) throw new Error(`--month must be YYYY-MM, got "${v ?? ""}"`);
      out.month = v;
      continue;
    }
    throw new Error(`unknown argument "${arg}" (expected --month YYYY-MM | --json)`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseCostArgs(process.argv.slice(2));
  loadEnvFiles();
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const report = await runCostReport({
      prisma,
      reportsDir: path.join(PKG_ROOT, "reports"),
      month: args.month,
      log: args.json ? () => {} : undefined,
    });
    if (args.json) console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}
