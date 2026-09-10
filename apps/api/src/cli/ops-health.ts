/**
 * `ops:health` (W4b, docs/ops-hardening-plan.md) — read-only pipeline health.
 *
 * Answers, per lane: did a run happen, did it finish, and how fresh is the
 * data. Writes a dated artifact (logs/ops-health-<date>.json) and exits
 * non-zero on any alert, so it works both as a manual check and as the daily
 * chain's post-condition (W1c) — the only check that can catch a process killed
 * outright, which no exit code inside that process can report.
 *
 * Usage: pnpm -C apps/api ops:health [--lane hk|us] [--json]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeHealth, type HealthReport, type LaneHealth } from "../ops/health.js";
import { PrismaService } from "../prisma.service.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** Repo-root logs/ — the same place the launchd jobs StandardOut to.
 *  Two levels up from apps/api; getting this off by one silently scatters
 *  artifacts into apps/logs, so it is exported and asserted in tests. */
export const LOG_DIR = path.join(PKG_ROOT, "..", "..", "logs");

export interface OpsHealthArgs {
  lane?: "hk" | "us";
}

export function parseOpsHealthArgs(argv: string[]): OpsHealthArgs {
  const out: OpsHealthArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue; // pnpm passes a bare --
    if (arg === "--lane") {
      const v = argv[++i];
      if (v !== "hk" && v !== "us") throw new Error(`--lane must be hk|us, got "${v ?? ""}"`);
      out.lane = v;
      continue;
    }
    throw new Error(`unknown argument "${arg}" (expected --lane hk|us)`);
  }
  return out;
}

function renderLane(l: LaneHealth): string[] {
  const lines = [
    `${l.market}: ${l.level.toUpperCase()} · last complete run ${l.lastCompleteRunId ?? "—"}` +
      `${l.lastCompleteRunAt ? ` (${l.lastCompleteRunAt})` : ""} · screen run ${l.lastScreenRunId ?? "—"}` +
      ` · data through ${l.dataThrough ?? "—"} · missed ${l.expectedRunsMissed}`,
  ];
  for (const r of l.reasons) lines.push(`    - ${r}`);
  return lines;
}

export function renderHealth(report: HealthReport): string {
  const lines = [`== OPS HEALTH == ${report.asOf} · ${report.level.toUpperCase()}`];
  for (const l of report.lanes) lines.push(...renderLane(l));
  for (const j of report.jobs) {
    lines.push(`${j.job}: ${j.level.toUpperCase()} · last artifact ${j.lastArtifactDate ?? "—"}`);
    for (const r of j.reasons) lines.push(`    - ${r}`);
  }
  return lines.join("\n");
}

export function todayHkt(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function opsHealthArtifactPath(now: Date = new Date()): string {
  return path.join(LOG_DIR, `ops-health-${todayHkt(now)}.json`);
}

async function main(): Promise<void> {
  const args = parseOpsHealthArgs(process.argv.slice(2));
  const prisma = new PrismaService();
  await prisma.$connect();
  let report: HealthReport;
  try {
    report = await computeHealth(prisma);
  } finally {
    await prisma.$disconnect();
  }

  // --lane narrows the *reported* level for a single-lane post-condition check
  // (the US chain must not fail because the HK lane is stale).
  const scoped: HealthReport = args.lane
    ? { ...report, level: report.lanes.find((l) => l.market === args.lane!.toUpperCase())?.level ?? "alert" }
    : report;

  console.log(renderHealth(report));
  if (args.lane) console.log(`\n(scoped to ${args.lane.toUpperCase()}: ${scoped.level.toUpperCase()})`);

  const logDir = LOG_DIR;
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(opsHealthArtifactPath(), JSON.stringify(report, null, 2));
  } catch (err) {
    // Never let artifact writing decide the verdict.
    console.error(`WARN could not write ops-health artifact: ${String((err as Error)?.message ?? err)}`);
  }

  if (scoped.level === "alert") process.exitCode = 1;
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}
