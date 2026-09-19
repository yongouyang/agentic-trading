/**
 * `north-star` — the hypothesis register readout (docs/north-star-metric-lock.md).
 *
 * The one place the register, the projection basis and the class distribution are
 * visible together. It is load-bearing rather than decorative: the North Star
 * metric's **L2 completion condition reads it** ("the register has no live entries"),
 * so a register that can silently lose a row would change a locked verdict. That is
 * why the register is DECLARED (`docs/hypothesis-register.json`, reviewed by diff)
 * rather than derived — which artifact is authoritative for a retired class is a
 * governance choice, not an inference — and why the checks below fail loudly.
 *
 * What it derives (reusing the two existing clocks, so there is no third
 * implementation of the same arithmetic):
 *   verdict:validate  → H2's progress, basis and readiness
 *   phase4c:accrual   → Track B's progress
 * and the supply rate from the weekly digest series, which is the only reading here
 * that can be wrong without looking wrong — hence the staleness rule: a projected
 * date is WITHHELD unless the supply was measured within 4 weeks.
 *
 * Two readings, never conflated (metric lock D1):
 *   A  progress        observedDays / daysNeeded   — observation-days ÷ observation-days
 *   B  projected date  today + (daysNeeded − observedDays) / measured supply
 *
 * Exit code: **non-zero on a BROKEN register check** — unlike the two clocks above,
 * which exit 0 by design because they are status readouts. A register that fails to
 * reconcile must not be able to produce a "nothing is live, L2 is complete" reading.
 *
 *   pnpm -C apps/api north-star [--json] [--register <file>]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PrismaService } from "../prisma.service.js";
import { runAccrual } from "./accrual.js";
import { parseValidateArgs, runValidation, type ValidationReport } from "./verdict-validate.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
export const REGISTER_FILE = path.join(REPO_ROOT, "docs", "hypothesis-register.json");
export const DIGEST_DIR = path.join(REPO_ROOT, "logs");
export const REPORT_DIR = path.join(PKG_ROOT, "reports");
/** A projected date is withheld unless the supply was measured within this window. */
export const SUPPLY_STALE_WEEKS = 4;

export const FIVE_CLASSES = ["supported", "falsified", "insufficient_evidence", "underpowered", "inconclusive"] as const;
export type VerdictClass = (typeof FIVE_CLASSES)[number];

export interface RegisterRow {
  id: string;
  title: string;
  statistic: string;
  universe: string;
  window: string;
  bar: string;
  barLockedAt: string;
  barDoc: string;
  state: "live" | "retired";
  /** live rows only: whether the row may gate. An accruing-only row cannot. */
  clock?: "gating" | "accruing-only";
  class?: VerdictClass;
  classAt?: string;
  classDoc?: string;
  artifact?: string;
  artifactClassLocator?: string;
  artifactClass?: VerdictClass | null;
  divergenceReason?: string;
  note?: string;
}

export interface HypothesisRegister {
  version: number;
  metricDoc: string;
  metricLockedAt: string;
  hypotheses: RegisterRow[];
}

// ---------------------------------------------------------------------------
// pure: locator, schema, artifact checks
// ---------------------------------------------------------------------------

/**
 * Evaluate a locator like `lanes[].verdict` or `lane.gate2Base.nwT` and return
 * EVERY value it addresses (the `[]` step maps over an array). Multi-value on
 * purpose: a two-lane artifact must not be checked against only its first lane.
 */
export function locateAll(node: unknown, locator: string): unknown[] {
  let current: unknown[] = [node];
  for (const step of locator.split(".")) {
    const map = step.endsWith("[]");
    const key = map ? step.slice(0, -2) : step;
    const next: unknown[] = [];
    for (const cur of current) {
      if (cur == null || typeof cur !== "object") continue;
      const v = (cur as Record<string, unknown>)[key];
      if (v == null) continue;
      if (map) {
        if (Array.isArray(v)) next.push(...v);
      } else next.push(v);
    }
    current = next;
  }
  return current;
}

export function validateRegister(reg: HypothesisRegister): string[] {
  const errors: string[] = [];
  if (!Array.isArray(reg.hypotheses) || reg.hypotheses.length === 0) errors.push("hypotheses must be a non-empty array");
  const seen = new Set<string>();
  for (const r of reg.hypotheses ?? []) {
    const at = `row ${r.id ?? "(no id)"}`;
    if (!r.id) errors.push(`${at}: missing id`);
    else if (seen.has(r.id)) errors.push(`${at}: duplicate id`);
    else seen.add(r.id);
    for (const field of ["title", "statistic", "universe", "window", "bar", "barLockedAt", "barDoc"] as const) {
      if (!r[field]) errors.push(`${at}: missing ${field}`);
    }
    if (r.state !== "live" && r.state !== "retired") errors.push(`${at}: state must be live|retired`);
    if (r.state === "live" && r.clock !== "gating" && r.clock !== "accruing-only") {
      errors.push(`${at}: a live row needs clock gating|accruing-only`);
    }
    if (r.state === "retired") {
      if (!r.class) errors.push(`${at}: a retired row needs a class`);
      else if (!FIVE_CLASSES.includes(r.class)) errors.push(`${at}: class ${r.class} is outside the fixed five-class vocabulary`);
      if (!r.classAt) errors.push(`${at}: a retired row needs classAt`);
      if (!r.classDoc) errors.push(`${at}: a retired row needs classDoc`);
      if (!r.artifactClassLocator && !r.divergenceReason) {
        errors.push(`${at}: a retired row whose artifact carries no class needs a divergenceReason saying how the class was mapped`);
      }
      if (r.artifactClassLocator && r.class !== r.artifactClass && !r.divergenceReason) {
        errors.push(`${at}: class differs from artifactClass, which needs a divergenceReason`);
      }
    }
  }
  return errors;
}

export type ArtifactState = "MATCH" | "DIVERGENT" | "MAPPED" | "BROKEN" | "PROVENANCE";
export interface ArtifactCheck {
  id: string;
  state: ArtifactState;
  detail: string;
}

/** Verify every declared artifact exists, and — where a locator is given — that the
 *  file actually says what the register claims it says. */
export function checkArtifacts(reg: HypothesisRegister, root: string = REPO_ROOT): ArtifactCheck[] {
  const out: ArtifactCheck[] = [];
  for (const r of reg.hypotheses) {
    if (!r.artifact) {
      out.push({ id: r.id, state: "PROVENANCE", detail: "no artifact declared" });
      continue;
    }
    const file = path.join(root, r.artifact);
    if (!existsSync(file)) {
      out.push({ id: r.id, state: "BROKEN", detail: `artifact missing: ${r.artifact}` });
      continue;
    }
    if (!r.artifactClassLocator) {
      out.push({
        id: r.id,
        state: r.state === "retired" ? "MAPPED" : "PROVENANCE",
        detail:
          r.state === "live"
            ? "artifact present, used as provenance only — a live row has no class to map"
            : `artifact present; no class in it — ${r.divergenceReason ? "mapping declared" : "mapping NOT declared"}`, 
      });
      continue;
    }
    let located: unknown[];
    try {
      located = locateAll(JSON.parse(readFileSync(file, "utf8")), r.artifactClassLocator);
    } catch (e) {
      out.push({ id: r.id, state: "BROKEN", detail: `artifact unreadable: ${(e as Error).message}` });
      continue;
    }
    if (located.length === 0) {
      out.push({ id: r.id, state: "BROKEN", detail: `locator ${r.artifactClassLocator} matched nothing in ${r.artifact}` });
      continue;
    }
    const mismatch = located.filter((v) => v !== r.artifactClass);
    if (mismatch.length > 0) {
      out.push({
        id: r.id,
        state: "BROKEN",
        detail: `artifact says ${JSON.stringify([...new Set(mismatch)])} at ${r.artifactClassLocator}, register declares artifactClass ${JSON.stringify(r.artifactClass)}`,
      });
      continue;
    }
    out.push(
      r.class === r.artifactClass
        ? { id: r.id, state: "MATCH", detail: `${r.artifactClassLocator} = ${JSON.stringify(r.artifactClass)} (all ${located.length} located)` }
        : { id: r.id, state: "DIVERGENT", detail: `artifact says ${JSON.stringify(r.artifactClass)}; governing class is ${r.class} — reason declared` },
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// pure: supply, projections, project level
// ---------------------------------------------------------------------------

export interface Supply {
  /** Observation-days added per week, measured between two digests. */
  perWeek: number;
  from: string;
  to: string;
  days: number;
  stale: boolean;
}

/** Build a `pooled.days` series from the weekly digests and difference the last two. */
export function measureSupply(digestDir: string, now: Date = new Date()): Supply | null {
  let files: string[];
  try {
    files = readdirSync(digestDir).filter((f) => /^validation-digest-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch {
    return null;
  }
  const points: { date: string; days: number }[] = [];
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(path.join(digestDir, f), "utf8")) as { date?: string; pooled?: { days?: number | null } };
      const days = d.pooled?.days;
      if (typeof days === "number") points.push({ date: d.date ?? f.slice(-15, -5), days });
    } catch {
      // a digest that cannot be read is not a measurement point
    }
  }
  if (points.length < 2) return null;
  const [older, newer] = points.slice(-2) as [{ date: string; days: number }, { date: string; days: number }];
  const weeks = (Date.parse(newer.date) - Date.parse(older.date)) / (7 * 86_400_000);
  if (!(weeks > 0)) return null;
  const perWeek = (newer.days - older.days) / weeks;
  if (!(perWeek > 0)) return null;
  return { perWeek, from: older.date, to: newer.date, days: newer.days - older.days, stale: (now.getTime() - Date.parse(newer.date)) / (7 * 86_400_000) > SUPPLY_STALE_WEEKS };
}

export interface LiveReading {
  id: string;
  gating: boolean;
  /** Reading A: observedDays / daysNeeded, both observation-days. */
  observedDays: number | null;
  daysNeeded: number | null;
  progress: number | null;
  /** Reading B: an ISO date, or null when withheld, with the reason. */
  projectedDate: string | null;
  withheldReason: string | null;
  basis: string | null;
  detail: string;
}

export function projectDate(observedDays: number | null, daysNeeded: number | null, supply: Supply | null, now: Date): { date: string | null; reason: string | null } {
  if (observedDays == null || daysNeeded == null) return { date: null, reason: "no observation-days or daysNeeded reading" };
  if (!supply) {
    // Two distinct situations, and the message must not blame the wrong one: fewer
    // than two digests (nothing to difference yet) versus two agreed digests showing
    // no gain at all (no observation-days have accrued). With the register at 0/157
    // the second is the true state, and saying "needs two digests" would send a
    // reader to fix a clock that is already running.
    return { date: null, reason: "supply not measurable — no positive gain in pooled observation-days across the weekly digests yet (needs two digests AND some accrual), so any date would be extrapolation" };
  }
  if (supply.stale) return { date: null, reason: `supply not measured since ${supply.to} (older than ${SUPPLY_STALE_WEEKS} weeks)` };
  const remaining = daysNeeded - observedDays;
  if (remaining <= 0) return { date: now.toISOString().slice(0, 10), reason: null };
  const days = (remaining / supply.perWeek) * 7;
  return { date: new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10), reason: null };
}

/** D2: the project-level reading is the last GATING live hypothesis's date, and L2
 *  completes when no gating row is live. An accruing-only row cannot extend it — or
 *  L2 would be unreachable by construction. */
export function projectLevel(readings: LiveReading[]): { date: string | null; withheld: string[]; liveGating: number; complete: boolean } {
  const gating = readings.filter((r) => r.gating);
  const withheld = gating.filter((r) => r.projectedDate == null).map((r) => r.id);
  const dates = gating.map((r) => r.projectedDate).filter((d): d is string => d != null);
  return {
    date: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
    withheld,
    liveGating: gating.length,
    complete: gating.length === 0,
  };
}

// ---------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------

export interface NorthStarReport {
  generatedAt: string;
  metricDoc: string;
  rows: RegisterRow[];
  artifacts: ArtifactCheck[];
  schemaErrors: string[];
  readings: LiveReading[];
  supply: Supply | null;
  project: ReturnType<typeof projectLevel>;
  classes: Record<string, number>;
  verdict: "OK" | "BROKEN";
}

export function parseNorthStarArgs(argv: string[]): { json: boolean; register: string } {
  let json = false;
  let register = REGISTER_FILE;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--json") json = true;
    else if (a === "--register") register = path.resolve(argv[++i] ?? "");
    else throw new Error(`unknown argument "${a}" (expected --json, --register <file>)`);
  }
  return { json, register };
}

function readingFromValidation(row: RegisterRow, v: ValidationReport, supply: Supply | null, now: Date): LiveReading {
  // The GOVERNING readout for H2 is IC | rank — the register says so, and the
  // validator keeps it in `readinessControlled`; `readiness` is the raw arm, which
  // is reported alongside because the two disagree (0/157 raw vs 0/159 |rank) and
  // the difference is the screen-rank leakage the controlled statistic removes.
  const pooled = v.pooled ?? v.lanes?.[0];
  const governing = pooled?.readinessControlled ?? null;
  const raw = pooled?.readiness ?? null;
  const observedDays = governing?.days ?? null;
  const daysNeeded = governing?.daysNeeded ?? null;
  const proj = projectDate(observedDays, daysNeeded, supply, now);
  return {
    id: row.id,
    gating: row.clock === "gating",
    observedDays,
    daysNeeded,
    progress: observedDays != null && daysNeeded ? observedDays / daysNeeded : null,
    projectedDate: proj.date,
    withheldReason: proj.reason,
    basis: governing?.seSource ?? null,
    detail:
      `governing (IC | rank): ${governing?.days ?? "—"}/${governing?.daysNeeded ?? "—"} days · raw arm: ${raw?.days ?? "—"}/${raw?.daysNeeded ?? "—"}` +
      ` · pending labels ${pooled?.pendingLabel ?? "—"} · ${governing?.reason ?? ""}`,
  };
}

/**
 * Track B's reading deliberately carries NO progress fraction, and this is the lock's
 * own rule rather than a simplification. `requiredDays` is a total-sample requirement
 * derived from the observed window's SE, while the prospective accrual is lane-days
 * collected since 2026-09-12 — different quantities, so a ratio of them would read as
 * 45 % complete when nothing prospective has happened at all. Both numbers are
 * reported, and the fraction is declined. Consistent with the row being accruing-only:
 * it cannot gate, so it has no date to withhold.
 */
function readingFromAccrual(row: RegisterRow, a: Awaited<ReturnType<typeof runAccrual>>, supply: Supply | null, now: Date): LiveReading {
  const us = a.lanes?.find((l) => l.market === "US") ?? a.lanes?.[0];
  const accruingOnly = row.clock !== "gating";
  return {
    id: row.id,
    gating: !accruingOnly,
    observedDays: us?.prospectiveSessions ?? null,
    daysNeeded: us?.requiredDays ?? null,
    progress: null,
    projectedDate: null,
    withheldReason: accruingOnly
      ? "accruing-only, not a clock (K-lock D3) — no progress fraction: the requirement and the accrual are different quantities"
      : (us?.additionalMonths != null ? `statistical requirement ~${us.requiredDays?.toLocaleString()} IC-days at the observed NW SE; ~${us.additionalMonths.toFixed(0)} more months at 21 sessions/month` : "no requirement computable"),
    basis: us?.observedNwSe != null ? "measured (observed NW SE)" : null,
    detail: us
      ? `prospective lane-days ${us.prospectiveSessions}/${us.expectedSessions} · observed window ${us.observedDays} IC-days at NW SE ${us.observedNwSe ?? "—"} · requirement ~${us.requiredDays?.toLocaleString() ?? "—"} IC-days (a different quantity from the accrual)`
      : "",
  };
}

export async function runNorthStar(
  prisma: PrismaService,
  args: { register: string },
  now: Date = new Date(),
): Promise<NorthStarReport> {
  const reg = JSON.parse(readFileSync(args.register, "utf8")) as HypothesisRegister;
  const schemaErrors = validateRegister(reg);
  const artifacts = checkArtifacts(reg);

  const validation = await runValidation(prisma, parseValidateArgs([]));
  const accrual = await runAccrual(prisma);
  const supply = measureSupply(DIGEST_DIR, now);

  const readings = reg.hypotheses
    .filter((r) => r.state === "live")
    .map((r) => (r.id === "H2-deepdive" ? readingFromValidation(r, validation, supply, now) : readingFromAccrual(r, accrual, supply, now)));

  const classes: Record<string, number> = {};
  for (const r of reg.hypotheses) if (r.state === "retired" && r.class) classes[r.class] = (classes[r.class] ?? 0) + 1;

  const broken = schemaErrors.length > 0 || artifacts.some((a) => a.state === "BROKEN");
  return {
    generatedAt: now.toISOString(),
    metricDoc: reg.metricDoc,
    rows: reg.hypotheses,
    artifacts,
    schemaErrors,
    readings,
    supply,
    project: projectLevel(readings),
    classes,
    verdict: broken ? "BROKEN" : "OK",
  };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);

export function renderNorthStar(r: NorthStarReport): string[] {
  const out: string[] = [];
  out.push(`== NORTH STAR — HYPOTHESIS REGISTER == ${r.generatedAt.slice(0, 10)}`);
  out.push("metric: time-to-verdict at pre-registered power · two readings, never conflated (A progress = observation-days ÷ observation-days; B projected date = from MEASURED supply)");
  out.push(`register: ${r.rows.length} hypotheses · ${r.rows.filter((h) => h.state === "retired").length} retired · ${r.rows.filter((h) => h.state === "live").length} live  (${r.metricDoc})`);
  out.push("");

  out.push(`  ${"hypothesis".padEnd(21)} ${"state".padEnd(8)} ${"clock".padEnd(13)} ${"class".padEnd(20)} progress   projected   basis`);
  for (const row of r.rows) {
    const rd = r.readings.find((x) => x.id === row.id);
    out.push(
      `  ${row.id.padEnd(21)} ${row.state.padEnd(8)} ${(row.clock ?? "—").padEnd(13)} ${(row.class ?? "—").padEnd(20)} ` +
        `${(rd ? pct(rd.progress) : "—").padStart(8)}   ${(rd?.projectedDate ?? (rd ? "withheld" : "—")).padEnd(11)} ${rd?.basis ?? "—"}`,
    );
  }
  out.push("");

  // L2 — the falsifiable completion condition the metric lock added.
  out.push(`L2 — It can decide: ${r.project.complete ? "COMPLETE (no gating hypothesis is live)" : `NOT MET — ${r.project.liveGating} gating hypothesis(es) still live`}`);
  out.push(
    `project-level reading (last gating hypothesis): ${r.project.complete ? "—" : (r.project.date ?? "WITHHELD")}` +
      (r.project.withheld.length ? `  (withheld for: ${r.project.withheld.join(", ")})` : ""),
  );
  out.push(
    `supply: ${r.supply ? `${r.supply.perWeek.toFixed(2)} observation-days/week measured ${r.supply.from} → ${r.supply.to}${r.supply.stale ? " · STALE" : ""}` : "not measurable yet — no positive gain in pooled observation-days across the weekly digests (so any projected date would be extrapolation, and Reading B is withheld)"}`,
  );
  out.push(`classes (retired): ${Object.entries(r.classes).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}   — published so the metric is not read as \"we are winning\"`);
  out.push("");

  out.push("register integrity (a broken check exits non-zero — L2's completion condition reads this file):");
  if (r.schemaErrors.length) for (const e of r.schemaErrors) out.push(`  SCHEMA   ${e}`);
  for (const a of r.artifacts) out.push(`  ${a.state.padEnd(9)} ${a.id.padEnd(21)} ${a.detail}`);
  for (const rd of r.readings) {
    // Both, always: a withheld date is a statement about Reading B, and Reading A
    // plus the basis are exactly what a reader needs to see next to it.
    if (rd.detail) out.push(`  READING   ${rd.id.padEnd(21)} ${rd.detail}`);
    if (rd.withheldReason) out.push(`  WITHHELD  ${rd.id.padEnd(21)} ${rd.withheldReason}`);
  }
  out.push("");
  out.push(`REGISTER: ${r.verdict}`);
  out.push("The anti-Goodhart clause (metric lock §4): this reading may be improved only by supplying observation-days or by a design change made BEFORE outcomes — never by moving targetIc, Z, the horizon, the breadth in daysNeeded, the observation-day definition, or the declared sd basis.");
  return out;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseNorthStarArgs(process.argv.slice(2));
  const prisma = new PrismaService();
  await prisma.$connect();
  let report: NorthStarReport;
  try {
    report = await runNorthStar(prisma, args);
  } finally {
    await prisma.$disconnect();
  }
  const text = renderNorthStar(report).join("\n");
  console.log(text);

  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = report.generatedAt.slice(0, 10);
  writeFileSync(path.join(REPORT_DIR, `north-star-${stamp}.json`), JSON.stringify(report, null, 2));
  if (args.json) console.log(JSON.stringify(report, null, 2));
  process.exit(report.verdict === "OK" ? 0 : 1);
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}