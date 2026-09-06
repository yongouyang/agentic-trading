/**
 * SplitEvent addition (migration-style, loudly logged) — the append side of
 * delete-split-event.ts. Built for verified in-band registry additions the
 * importer's bulk CSV path doesn't cover (e.g. BHVN 2022-10-04, the
 * Pfizer/new-Biohaven discontinuity found in the XNYS FAR-candidate review,
 * PROGRESS 2026-09-06).
 *
 *   pnpm -C apps/api split:add -- --symbol BHVN --ex-date 2022-10-04 \
 *     --event FORWARD_SPLIT --ratio-new 18.289 --ratio-old 1 --reason "..."
 *
 * factor is derived (ratioNew/ratioOld) and must agree with --event's
 * direction (forward > 1, reverse < 1). confidence follows --source
 * (yahoo → authoritative, inband → estimated). Refuses (exit 1) when the
 * (symbol, exDate) row already exists — delete first to replace. Prints the
 * created row's JSON. Registry rows are NEVER added silently anywhere else.
 */
import { pathToFileURL } from "node:url";
import { PrismaService } from "../prisma.service.js";

type Prisma = PrismaService;

export interface AddSplitArgs {
  symbol: string;
  exDate: string;
  event: string;
  ratioNew: number;
  ratioOld: number;
  source: string;
}

export function buildSplitEventRow(a: AddSplitArgs) {
  if (!a.symbol) throw new Error("--symbol is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.exDate)) throw new Error(`--ex-date must be YYYY-MM-DD, got "${a.exDate}"`);
  if (a.event !== "FORWARD_SPLIT" && a.event !== "REVERSE_SPLIT")
    throw new Error(`--event must be FORWARD_SPLIT | REVERSE_SPLIT, got "${a.event}"`);
  if (!(a.ratioNew > 0) || !(a.ratioOld > 0))
    throw new Error(`--ratio-new/--ratio-old must be positive, got ${a.ratioNew}:${a.ratioOld}`);
  if (a.source !== "yahoo" && a.source !== "inband")
    throw new Error(`--source must be yahoo | inband, got "${a.source}"`);
  const factor = a.ratioNew / a.ratioOld;
  if (a.event === "FORWARD_SPLIT" && factor <= 1)
    throw new Error(`FORWARD_SPLIT requires factor > 1, got ${factor} (${a.ratioNew}:${a.ratioOld})`);
  if (a.event === "REVERSE_SPLIT" && factor >= 1)
    throw new Error(`REVERSE_SPLIT requires factor < 1, got ${factor} (${a.ratioNew}:${a.ratioOld})`);
  return {
    symbol: a.symbol,
    exDate: a.exDate,
    event: a.event,
    ratioNew: a.ratioNew,
    ratioOld: a.ratioOld,
    factor,
    source: a.source,
    confidence: a.source === "yahoo" ? "authoritative" : "estimated",
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const reason = get("--reason") ?? "(no reason given)";
  const num = (v: string | undefined) => (v === undefined ? NaN : Number(v));

  const row = buildSplitEventRow({
    symbol: get("--symbol") ?? "",
    exDate: get("--ex-date") ?? "",
    event: get("--event") ?? "",
    ratioNew: num(get("--ratio-new")),
    ratioOld: num(get("--ratio-old")),
    source: get("--source") ?? "inband",
  });

  const prisma = new PrismaService();
  try {
    const existing = await prisma.splitEvent.findUnique({
      where: { symbol_exDate: { symbol: row.symbol, exDate: row.exDate } },
    });
    if (existing) {
      console.error(`SplitEvent row for (${row.symbol}, ${row.exDate}) already exists: ${JSON.stringify(existing)} — refusing.`);
      process.exitCode = 1;
      return;
    }
    const created = await prisma.splitEvent.create({ data: row });
    console.log(`[add-split-event] reason: ${reason} | created: ${JSON.stringify(created)}`);
    const total = await prisma.splitEvent.count({ where: { symbol: row.symbol } });
    console.log(`[add-split-event] total SplitEvent rows for ${row.symbol}: ${total}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
