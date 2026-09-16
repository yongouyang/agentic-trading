/**
 * `verdict:validate` — score the LLM deep-dive layer (Phase 5, docs/phase-5-plan.md).
 *
 * Phases 4/4b spent the deterministic screen's only window. This scores the layer
 * that has never been scored at all, prospectively, from rows the pipeline writes
 * anyway.
 *
 * **It is designed to refuse to answer.** At ~10 verdicts/day a per-day
 * conviction IC has SE ≈ 1/√(N−1) ≈ 0.33, and 20d labels overlap, so a modest IC
 * of 0.10 is years of accrual away. The readiness rule is a *power condition*
 * (`SE(mean) ≤ IC_target / 2.487`, i.e. 80 % power at one-sided α = 0.05), not a
 * threshold someone picked, and only a **measured** SE may authorise a decision.
 * Until then the verdict is `insufficient_evidence`, which is the expected output
 * for months and is deliberately **not** phrased as a failure — Phase 4's defect
 * was a FAIL that read as a negative finding when the test could say nothing.
 *
 * Read-only over `DeepDiveRun`/`DeepDiveReport`/`bar`.
 *
 * Usage: pnpm -C apps/api verdict:validate [--json] [--lane hk|us] [--target-ic 0.10]
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Bar, CorporateAction } from "@agentic-trading/quant-core";
import {
  buildForwardSeries,
  forwardReturn,
  neweyWestT,
  verdictConvictionSplit,
  verdictFor,
  verdictIcSeries,
  verdictIcSeriesControlled,
  theoreticalSdDay,
  type Market,
  type VerdictObservation,
} from "@agentic-trading/quant-core";
import { SCREEN_PARAMS } from "@agentic-trading/quant-core";
import { PrismaService } from "../prisma.service.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** Primary horizon, matching Phase 4's so the overlap correction is comparable. */
export const PRIMARY_HORIZON = 20;
/** Target effect the readiness rule is set to detect. Fork B of the Phase-5 plan. */
export const DEFAULT_TARGET_IC = 0.1;
/**
 * How many calendar days late a run may be and still count as a prospective
 * observation. 1 accommodates the US lane's own convention — the evening chain
 * (20:30 HKT) screens the PREVIOUS US session, which closed 04:00/05:00 HKT
 * that morning, so `runDate = entry + 1` is *prompt* — while rejecting
 * anything later.
 *
 * This exists because the evening catch-up slot (20:30 daily, including weekends)
 * can legitimately run a session two or more days behind: a Sunday catch-up of
 * Friday's HK session produces verdicts formed with **weekend news**, i.e.
 * information unavailable at Friday's close. That is look-ahead in the X variable,
 * which is precisely what the design avoids, and without this rule such verdicts
 * would enter the sample indistinguishable from prompt ones.
 */
export const MAX_PROMPT_LAG_DAYS = 1;

/**
 * The sample must be ONE treatment. A verdict is only an observation of the
 * shipped prompt, so anything carrying a different `promptVersion` is excluded
 * and counted.
 *
 * Same failure class as the promptness gate: shipping a v2 prompt would otherwise
 * pool two treatments into one IC, silently and attractively — a change made
 * *because* you saw bad outputs would be measured as an improvement. The
 * consequence is deliberate and worth knowing: **shipping a new prompt version
 * resets this clock**, because the accrued verdicts stop counting. Better to see
 * that as a jump in the excluded count than to have a sample describing two
 * different systems.
 *
 * MUST equal PROMPT_VERSION in packages/agents/src/prompts.ts. It is a local
 * constant, mirroring CHAT_PROMPT_VERSION in src/chat/chat-prompts.ts, because a
 * cross-package value import resolves to undefined under this package's vitest —
 * and an undefined sample version would silently exclude every verdict. The
 * pairing is pinned from the other side by a test in packages/agents, so bumping
 * the prompt fails loudly rather than quietly emptying the sample.
 */
export const SAMPLE_PROMPT_VERSION = "v1";

/**
 * The sample must be ONE treatment in model identity exactly as in prompt
 * identity (Phase-5 amendments A6, 2026-09-13, and A7, 2026-09-16 — both
 * pre-label). A verdict produced by any other model is excluded and counted,
 * never pooled: a model change shows up as a jump in `otherModelExcluded`, not
 * as a silent treatment swap. Exact string match, deliberately — whether a new
 * model is "the same treatment" is a decision for the moment it appears, never
 * the gate's call.
 *
 * A6 froze k3-256k on all three roles and verified the then-accrued sample
 * against it (all 838 AgentDecision rows; see A6's one-time table). A7
 * re-baselined the stack to DeepSeek `deepseek-flash` after the Kimi weekly
 * quota wall lost 4 of 63 names on 2026-09-16 and the local profile moved onto
 * the provider `architecture-v1.md` §7 already pinned for deploy.
 *
 * A7 is a RE-BASELINE, **not** a pooling: the k3 era is a closed sub-sample.
 * Those rows now mismatch — post-gate verdicts are counted as
 * `otherModelExcluded`, and pre-gate verdicts as `legacyModelUnverifiable`
 * (their decision hashes still resolve to k3-256k, which is no longer in the
 * frozen set). Cost, recorded rather than hidden: ~8-10 lane-days of accrued
 * sample (~3-6 % of the 157-day pooled horizon) leave the deciding statistic.
 */
export const SAMPLE_MODEL_STACK = { analyst: "deepseek-flash", debate: "deepseek-flash", verdict: "deepseek-flash" } as const;

/** Calendar-day difference between two ISO dates (b − a). */
export function daysBetweenIso(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number) as [number, number, number];
  const [by, bm, bd] = b.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Breadth assumed before the series can measure its own sd. Derived from the
 *  configured candidate limit so a change to deep-dive breadth cannot leave the
 *  readiness projection pointing at a world that no longer exists (Phase 5
 *  Fork A: 40/lane, not the historical 10). */
export const ASSUMED_BREADTH: number = Math.max(...Object.values(SCREEN_PARAMS.topN));

export interface ValidateArgs {
  json: boolean;
  markets: Market[];
  targetIc: number;
}

export function parseValidateArgs(argv: string[]): ValidateArgs {
  const out: ValidateArgs = { json: false, markets: ["US", "HK"], targetIc: DEFAULT_TARGET_IC };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--" || a === "--quiet") continue;
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a === "--lane") {
      const v = argv[++i];
      if (v === "us") out.markets = ["US"];
      else if (v === "hk") out.markets = ["HK"];
      else throw new Error(`--lane must be us|hk, got "${v ?? ""}"`);
      continue;
    }
    if (a === "--target-ic") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`--target-ic must be a positive number, got "${argv[i] ?? ""}"`);
      out.targetIc = v;
      continue;
    }
    throw new Error(`unknown argument "${a}" (expected --json, --lane us|hk, --target-ic <n>)`);
  }
  return out;
}

/** The HKT calendar date of a run — the session whose bars it saw. */
export function hktDate(d: Date): string {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Newest bar date at or before `date`. */
export function entryDate(barDates: string[], date: string): string | null {
  let found: string | null = null;
  for (const d of barDates) {
    if (d <= date) found = d;
    else break;
  }
  return found;
}

export interface LaneValidation {
  /** "POOLED" for the combined row, which is the primary read (Fork C). */
  market: Market | "POOLED";
  /** Complete runs scanned for the lane — including runs whose verdicts were
   *  all excluded (late / version / failed), so this is a coverage figure, not
   *  a sample-contributing count. */
  runs: number;
  /** Verdicts with a conviction and a computable forward return. */
  labelled: number;
  /** Verdicts seen but not yet scorable (horizon has not elapsed). */
  pendingLabel: number;
  /** Verdicts EXCLUDED as temporally contaminated: the run happened more than
   *  `MAX_PROMPT_LAG_DAYS` after the session it screened, so its conviction was
   *  formed with information the entry bar did not have. Reported, never silently
   *  dropped. */
  lateExcluded: number;
  /** Verdicts EXCLUDED as non-prospective: the run carried `source: "adhoc"`,
   *  i.e. an operator-selected run (`--symbol`, an explicit `--top`, `--as-of`)
   *  rather than the scheduled chain. The lane's names were chosen by hand, so
   *  the cross-section is a selection, not a sample. Reported for the same reason
   *  as `lateExcluded`.
   *
   *  This is the same defect class as the promptness gate, and the same one the
   *  dashboard already had: `ops/health.ts` pins `source: "chain"` so an
   *  experiment cannot become the lane's view. The deciding statistic needs the
   *  same pin — a hand-picked run scored as an observation is selection bias in
   *  the X variable. */
  adhocExcluded: number;
  /** Verdicts EXCLUDED for carrying a different `promptVersion` — a second
   *  treatment, not more data. Reported for the same reason as `lateExcluded`. */
  otherVersionExcluded: number;
  /** Verdicts EXCLUDED for carrying a `models` stack that does not exactly
   *  match `SAMPLE_MODEL_STACK` (Phase-5 A6) — a second treatment in model
   *  identity. Reported for the same reason as `otherVersionExcluded`. */
  otherModelExcluded: number;
  /** Pre-gate verdicts (no `models` field) whose recorded AgentDecision rows
   *  all resolve to the frozen stack — verified, not defaulted (A6, Fork A). */
  legacyModelVerified: number;
  /** Pre-gate verdicts whose `decisionHashesJson` could not be fully resolved
   *  to frozen-stack AgentDecision rows — excluded, never assumed. */
  legacyModelUnverifiable: number;
  /** Reports EXCLUDED because the deep-dive failed and `verdictJson` is null —
   *  counted separately from `otherVersionExcluded`, which means an actual
   *  prompt-version mismatch, not a missing verdict. */
  failedExcluded: number;
  abstains: number;
  days: number;
  /** Raw conviction IC — "does conviction order outcomes?" (confounded). */
  meanIc: number | null;
  icir: number | null;
  nwT: number | null;
  /** IC controlling for screen rank — the ATTRIBUTION statistic that decides H2
   *  (Phase 5 amendment). ~0 here with a positive raw IC means the layer echoes
   *  the ranking rather than adding to it. */
  meanIcControlled: number | null;
  nwTControlled: number | null;
  verdictControlled: string;
  readinessControlled: { days: number; daysNeeded: number; decidable: boolean; seSource: string; reason: string };
  /** Secondary, benchmark-free: high- minus low-conviction within the day. */
  splitMean: number | null;
  splitNwT: number | null;
  readiness: { days: number; daysNeeded: number; decidable: boolean; seSource: string; reason: string };
  /** Measured per-day IC sd, and the theoretical value the projection assumed.
   *  Printed as a ratio when the sample is long enough to measure (see the
   *  projection-watch line in `renderValidation`) — Phase 4b found the assumed
   *  value off by 1.31–2.16×, and `daysNeeded ∝ sd²`, so this ratio is the
   *  earliest signal that the projected horizon is wrong. */
  sdDay: number | null;
  sdTheory: number | null;
  verdict: string;
}

export interface ValidationReport {
  asOf: string;
  horizon: number;
  targetIc: number;
  lanes: LaneValidation[];
  pooled: LaneValidation;
  note: string;
}

/**
 * Parse a stored verdict: its conviction, whether it abstained, and the prompt
 * version that produced it.
 *
 * The version comes from the JSON blob, NOT a column — `DeepDiveReport` stores
 * only `verdictJson`, and `Verdict` carries `promptVersion` inside it. Reading it
 * from a non-existent column would have excluded *everything* silently, which is
 * why this is asserted by test rather than assumed.
 *
 * A verdict with no readable version cannot be attributed to a treatment, so it
 * is excluded from the sample and counted, never defaulted to "current".
 */
export interface VerdictModels {
  analyst: string;
  debate: string;
  verdict: string;
}

export function convictionOf(verdictJson: string | null): {
  conviction: number | null;
  abstain: boolean;
  promptVersion: string | null;
  models: VerdictModels | null;
} {
  if (!verdictJson) return { conviction: null, abstain: false, promptVersion: null, models: null };
  try {
    const v = JSON.parse(verdictJson) as {
      conviction?: number;
      abstain?: boolean;
      promptVersion?: string;
      models?: { analyst?: unknown; debate?: unknown; verdict?: unknown };
    };
    const promptVersion = typeof v.promptVersion === "string" ? v.promptVersion : null;
    // The model stack is attributable only when all three roles are recorded
    // as strings — a partial blob is treated as absent (legacy path), never
    // as a partial match.
    const m = v.models;
    const models: VerdictModels | null =
      m && typeof m.analyst === "string" && typeof m.debate === "string" && typeof m.verdict === "string"
        ? { analyst: m.analyst, debate: m.debate, verdict: m.verdict }
        : null;
    if (v.abstain) return { conviction: null, abstain: true, promptVersion, models };
    return { conviction: typeof v.conviction === "number" ? v.conviction : null, abstain: false, promptVersion, models };
  } catch {
    return { conviction: null, abstain: false, promptVersion: null, models: null };
  }
}

async function loadMarket(
  prisma: PrismaService,
  market: Market,
): Promise<{
  obs: VerdictObservation[];
  runs: number;
  abstains: number;
  pending: number;
  late: number;
  adhoc: number;
  otherVersion: number;
  otherModel: number;
  legacyVerified: number;
  legacyUnverifiable: number;
  noVerdict: number;
}> {
  const instruments = await prisma.instrument.findMany({ where: { market } });
  const idToSymbol = new Map(instruments.map((i) => [i.id, i.symbol]));
  const ids = instruments.map((i) => i.id);

  const bars = (await prisma.bar.findMany({
    where: { instrumentId: { in: ids } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, date: true, open: true, high: true, low: true, close: true, volume: true },
  })) as (Bar & { instrumentId: number })[];
  const divs = (await prisma.corporateAction.findMany({
    where: { instrumentId: { in: ids }, type: "DIVIDEND" },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, date: true, type: true, amount: true, currency: true },
  })) as (CorporateAction & { instrumentId: number })[];

  const seriesBySymbol = new Map<string, ReturnType<typeof buildForwardSeries>>();
  const barsById = new Map<number, typeof bars>();
  for (const b of bars) {
    const list = barsById.get(b.instrumentId) ?? [];
    list.push(b);
    barsById.set(b.instrumentId, list);
  }
  const divsById = new Map<number, typeof divs>();
  for (const d of divs) {
    const list = divsById.get(d.instrumentId) ?? [];
    list.push(d);
    divsById.set(d.instrumentId, list);
  }
  for (const i of instruments) {
    const bs = barsById.get(i.id);
    if (!bs || bs.length === 0) continue;
    seriesBySymbol.set(
      i.symbol,
      buildForwardSeries(
        bs.map((b) => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })) as Bar[],
        (divsById.get(i.id) ?? []).map((d) => ({ date: d.date, type: "DIVIDEND" as const, amount: d.amount, currency: d.currency })),
      ),
    );
  }

  // The lane's session calendar, for picking the entry date of each run.
  const laneDates = [...new Set(bars.map((b) => b.date))].sort();

  const runs = await prisma.deepDiveRun.findMany({
    where: { market, status: "complete" },
    orderBy: { runAt: "asc" },
    include: { reports: true },
  });

  // The screen rank each verdict sat at, for the partial-correlation control.
  const rankByRun = new Map<number, Map<string, number>>();
  for (const run of runs) {
    const results = await prisma.screenResult.findMany({ where: { runId: run.screenRunId } });
    rankByRun.set(run.id, new Map(results.map((r) => [r.symbol, r.rank])));
  }

  const obs: VerdictObservation[] = [];
  let abstains = 0;
  let pending = 0;
  let late = 0;
  let adhoc = 0;
  let otherVersion = 0;
  let otherModel = 0;
  let legacyVerified = 0;
  let legacyUnverifiable = 0;
  let noVerdict = 0;
  // AgentDecision hash → model, loaded lazily on the first legacy verdict (a
  // verdict whose blob carries no `models`). The whole table is a few hundred
  // rows, so one bulk fetch beats a query per report.
  let modelByHash: Map<string, string> | null = null;
  const FROZEN_MODELS = new Set<string>(Object.values(SAMPLE_MODEL_STACK));
  /** Legacy rule (Phase-5 A6, Fork A): a pre-gate verdict is verified, not
   *  defaulted — every recorded decision hash must resolve to a frozen-stack
   *  model. ETF names legitimately lack the fundamentals-analyst hash, so the
   *  rule is "every hash PRESENT verifies", not "every role is present". Any
   *  unresolvable hash or off-stack model ⇒ unverifiable. */
  async function legacyModelOk(decisionHashesJson: string | null): Promise<boolean> {
    if (!decisionHashesJson) return false;
    let hashes: unknown;
    try {
      hashes = JSON.parse(decisionHashesJson);
    } catch {
      return false;
    }
    if (!Array.isArray(hashes) || hashes.length === 0 || hashes.some((h) => typeof h !== "string")) return false;
    if (modelByHash === null) {
      const rows = await prisma.agentDecision.findMany({ select: { hash: true, model: true } });
      modelByHash = new Map(rows.map((r) => [r.hash as string, r.model as string]));
    }
    return hashes.every((h) => {
      const model = modelByHash!.get(h as string);
      return model !== undefined && FROZEN_MODELS.has(model);
    });
  }
  for (const run of runs) {
    // Provenance gate: an operator run is not a prospective observation.
    // Checked BEFORE the promptness gate because "this was never a sample
    // member" is more fundamental than "this one was late". Compared against
    // "adhoc" rather than "!== chain" so the schema default ("chain") and any
    // row predating the column both read as scheduled, and only a run that
    // explicitly declares itself hand-built is removed.
    if (run.source === "adhoc") {
      adhoc += run.reports.length;
      continue;
    }
    const runDate = hktDate(run.runAt);
    const entry = entryDate(laneDates, runDate);
    if (!entry) continue;
    // Promptness gate: a late run's verdicts are look-ahead, not observations.
    if (daysBetweenIso(entry, runDate) > MAX_PROMPT_LAG_DAYS) {
      late += run.reports.length;
      continue;
    }
    for (const rep of run.reports) {
      // A FAILED deep-dive stores a report row with verdictJson null. That is
      // not a prompt-version mismatch — count it separately so the version
      // figure only ever means an actual different treatment.
      if (rep.verdictJson == null) {
        noVerdict++;
        continue;
      }
      const { conviction, abstain, promptVersion, models } = convictionOf(rep.verdictJson);
      // One treatment per sample: another prompt version is a different system,
      // not another observation of this one. An unattributable version is
      // excluded rather than assumed to be current.
      if (promptVersion !== SAMPLE_PROMPT_VERSION) {
        otherVersion++;
        continue;
      }
      // One treatment per sample in model identity too (Phase-5 A6): exact
      // match on all three roles, same exclude-and-count doctrine as the
      // promptVersion gate. Pre-gate verdicts carry no `models` field — they
      // are verified against their recorded AgentDecision rows, never
      // defaulted to the current stack.
      if (models !== null) {
        if (
          models.analyst !== SAMPLE_MODEL_STACK.analyst ||
          models.debate !== SAMPLE_MODEL_STACK.debate ||
          models.verdict !== SAMPLE_MODEL_STACK.verdict
        ) {
          otherModel++;
          continue;
        }
      } else if (await legacyModelOk(rep.decisionHashesJson)) {
        legacyVerified++;
      } else {
        legacyUnverifiable++;
        continue;
      }
      if (abstain) {
        abstains++;
        continue;
      }
      if (conviction == null) continue;
      const s = seriesBySymbol.get(rep.symbol);
      if (!s) continue;
      const rank = rankByRun.get(run.id)?.get(rep.symbol);
      if (rank === undefined) continue; // no rank ⇒ cannot attribute; skip, never guess
      const r = forwardReturn(s, entry, PRIMARY_HORIZON);
      if (r == null) pending++;
      obs.push({ date: entry, market, symbol: rep.symbol, conviction, rank, forwardReturn: r });
    }
  }
  return { obs, runs: runs.length, abstains, pending, late, adhoc, otherVersion, otherModel, legacyVerified, legacyUnverifiable, noVerdict };
}

function laneValidation(
  market: Market | "POOLED",
  obs: VerdictObservation[],
  runs: number,
  abstains: number,
  pending: number,
  late: number,
  adhoc: number,
  otherVersion: number,
  otherModel: number,
  legacyVerified: number,
  legacyUnverifiable: number,
  noVerdict: number,
  targetIc: number,
  assumedBreadth = ASSUMED_BREADTH,
): LaneValidation {
  const points = verdictIcSeries(obs);
  // Pooling two lanes doubles the per-day cross-section for the same calendar
  // time, so the projected horizon halves — the power gain Fork C is about.
  const { readiness, stats, verdict } = verdictFor(points, PRIMARY_HORIZON, targetIc, { assumedBreadth });
  // The attribution statistic: same gate, one covariate partialled out.
  const controlled = verdictFor(verdictIcSeriesControlled(obs), PRIMARY_HORIZON, targetIc, { assumedBreadth, controls: 1 });
  const split = verdictConvictionSplit(obs);
  const splitNw = split.length ? neweyWestT(split, PRIMARY_HORIZON) : null;
  return {
    market,
    runs,
    labelled: obs.filter((o) => o.forwardReturn != null).length,
    pendingLabel: pending,
    lateExcluded: late,
    adhocExcluded: adhoc,
    otherVersionExcluded: otherVersion,
    otherModelExcluded: otherModel,
    legacyModelVerified: legacyVerified,
    legacyModelUnverifiable: legacyUnverifiable,
    failedExcluded: noVerdict,
    abstains,
    days: points.length,
    meanIc: stats?.mean ?? null,
    icir: stats?.icir ?? null,
    nwT: stats?.nwT ?? null,
    meanIcControlled: controlled.stats?.mean ?? null,
    nwTControlled: controlled.stats?.nwT ?? null,
    verdictControlled: controlled.verdict,
    readinessControlled: {
      days: controlled.readiness.days,
      daysNeeded: controlled.readiness.daysNeeded,
      decidable: controlled.readiness.decidable,
      seSource: controlled.readiness.seSource,
      reason: controlled.readiness.reason,
    },
    splitMean: splitNw?.mean ?? null,
    splitNwT: splitNw?.t ?? null,
    readiness: {
      days: readiness.days,
      daysNeeded: readiness.daysNeeded,
      decidable: readiness.decidable,
      seSource: readiness.seSource,
      reason: readiness.reason,
    },
    sdDay: readiness.sdDay,
    sdTheory: theoreticalSdDay(assumedBreadth, 0),
    verdict,
  };
}

export function renderValidation(r: ValidationReport): string {
  const lines: string[] = [];
  lines.push(`== PHASE 5 — LLM DEEP-DIVE VALIDATION == ${r.asOf}`);
  lines.push(
    `horizon ${r.horizon}d · target IC ${r.targetIc} · readiness = 80 % power at one-sided alpha 0.05 (SE(mean) <= ${(r.targetIc / 2.4865).toFixed(4)})`,
  );
  const row = (l: LaneValidation) => {
    lines.push(
      `${l.market}: ${l.labelled} labelled verdicts over ${l.days} days · ${l.pendingLabel} awaiting a ${r.horizon}d label · ${l.abstains} abstains · ${l.runs} complete runs scanned` +
        `${l.lateExcluded > 0 ? ` · ${l.lateExcluded} EXCLUDED as late (look-ahead)` : ""}` +
        `${l.adhocExcluded > 0 ? ` · ${l.adhocExcluded} EXCLUDED (ad-hoc operator run, not a prospective sample)` : ""}` +
        `${l.otherVersionExcluded > 0 ? ` · ${l.otherVersionExcluded} EXCLUDED (different prompt version)` : ""}` +
        `${l.otherModelExcluded > 0 ? ` · ${l.otherModelExcluded} EXCLUDED (different model stack)` : ""}` +
        `${l.legacyModelVerified > 0 ? ` · ${l.legacyModelVerified} legacy verdicts VERIFIED against the frozen model stack (pre-gate, via decision hashes)` : ""}` +
        `${l.legacyModelUnverifiable > 0 ? ` · ${l.legacyModelUnverifiable} EXCLUDED (legacy verdict, model stack unverifiable)` : ""}` +
        `${l.failedExcluded > 0 ? ` · ${l.failedExcluded} EXCLUDED (deep-dive failed, no verdict)` : ""}`,
    );
    lines.push(
      `    raw IC ${l.meanIc == null ? "—" : l.meanIc.toFixed(4)} · ICIR ${l.icir == null ? "—" : l.icir.toFixed(3)} · NW t ${l.nwT == null ? "—" : l.nwT.toFixed(2)}` +
        ` · conviction split ${l.splitMean == null ? "—" : (l.splitMean * 100).toFixed(2) + "%"} (t ${l.splitNwT == null ? "—" : l.splitNwT.toFixed(2)})`,
    );
    // The attribution line: what DECIDES H2, printed second so the confounded
    // number is never read alone.
    lines.push(
      `    IC | rank (decides) ${l.meanIcControlled == null ? "—" : l.meanIcControlled.toFixed(4)} · NW t ${l.nwTControlled == null ? "—" : l.nwTControlled.toFixed(2)}` +
        ` · raw is 0.32 rank-correlated, so read the two together`,
    );
    lines.push(`    readiness (raw): ${l.readiness.reason}`);
    lines.push(`    readiness (|rank): ${l.readinessControlled.reason}`);
    // The projection watch. `daysNeeded` already self-corrects to the measured sd
    // the moment 20 days exist, but the RESCALING was invisible, and it is the
    // number that says whether the projected horizon is a floor or a fantasy:
    // Phase 4b measured the assumed cross-sectional sd to be 1.31× (HK) to
    // 2.16× (US) too small, and daysNeeded ∝ sd².
    if (l.readiness.seSource === "measured" && l.sdDay != null && l.sdTheory != null && l.sdTheory > 0) {
      const factor = l.sdDay / l.sdTheory;
      lines.push(
        `    projection watch: per-day IC sd ${l.sdDay.toFixed(4)} vs assumed ${l.sdTheory.toFixed(4)} = ${factor.toFixed(2)}x` +
          ` · daysNeeded rescaled to ${l.readiness.daysNeeded}` +
          (factor >= 1.5
            ? `  !! the 4b cross-sectional factor ran 1.31-2.16x; at ~${(l.readiness.daysNeeded).toFixed(0)} days the horizon is ~${(factor * factor).toFixed(1)}x the full-supply projection`
            : ""),
      );
    }
    lines.push(`    VERDICT ${l.market}: ${l.verdictControlled} (attribution) / ${l.verdict} (raw)`);
  };
  for (const l of r.lanes) row(l);
  lines.push("");
  lines.push("pooled (the same hypothesis over both universes — the cheapest legitimate power gain):");
  row(r.pooled);
  lines.push("");
  lines.push(r.note);
  return lines.join("\n");
}

export async function runValidation(prisma: PrismaService, args: ValidateArgs): Promise<ValidationReport> {
  const lanes: LaneValidation[] = [];
  const allObs: VerdictObservation[] = [];
  for (const market of args.markets) {
    const { obs, runs, abstains, pending, late, adhoc, otherVersion, otherModel, legacyVerified, legacyUnverifiable, noVerdict } =
      await loadMarket(prisma, market);
    allObs.push(...obs);
    lanes.push(
      laneValidation(
        market,
        obs,
        runs,
        abstains,
        pending,
        late,
        adhoc,
        otherVersion,
        otherModel,
        legacyVerified,
        legacyUnverifiable,
        noVerdict,
        args.targetIc,
        SCREEN_PARAMS.topN[market],
      ),
    );
  }
  const pooled = laneValidation(
    "POOLED",
    allObs,
    lanes.reduce((a, l) => a + l.runs, 0),
    lanes.reduce((a, l) => a + l.abstains, 0),
    lanes.reduce((a, l) => a + l.pendingLabel, 0),
    lanes.reduce((a, l) => a + l.lateExcluded, 0),
    lanes.reduce((a, l) => a + l.adhocExcluded, 0),
    lanes.reduce((a, l) => a + l.otherVersionExcluded, 0),
    lanes.reduce((a, l) => a + l.otherModelExcluded, 0),
    lanes.reduce((a, l) => a + l.legacyModelVerified, 0),
    lanes.reduce((a, l) => a + l.legacyModelUnverifiable, 0),
    lanes.reduce((a, l) => a + l.failedExcluded, 0),
    args.targetIc,
    ASSUMED_BREADTH * Math.max(1, args.markets.length),
  );
  return {
    asOf: new Date().toISOString(),
    horizon: PRIMARY_HORIZON,
    targetIc: args.targetIc,
    lanes,
    pooled,
    note:
      "`insufficient_evidence` is the expected output for months — it is not a failure, and it is not evidence of no edge. " +
      "The readiness rule refuses to decide until only a MEASURED se may authorise one, and the required horizon scales as 1/breadth: " +
      "widening the deep-dive is a token-cost decision, not a time decision (docs/phase-5-plan.md).",
  };
}

async function main(): Promise<void> {
  const args = parseValidateArgs(process.argv.slice(2));
  const prisma = new PrismaService();
  await prisma.$connect();
  let report: ValidationReport;
  try {
    report = await runValidation(prisma, args);
  } finally {
    await prisma.$disconnect();
  }
  console.log(args.json ? JSON.stringify(report, null, 2) : renderValidation(report));

  const dir = path.join(PKG_ROOT, "reports", "verdict");
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    writeFileSync(path.join(dir, `verdict-${stamp}.json`), JSON.stringify(report, null, 2));
  } catch {
    // never let artifact writing decide the verdict
  }
  // Exit 0 while undecidable, by design: this is a status readout, not a gate.
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}
