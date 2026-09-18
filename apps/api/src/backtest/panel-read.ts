/**
 * Phase 6A A5 — reading what A2 and A3 wrote.
 *
 * The two exports produce wide `date × symbol` CSVs with a `date` first column;
 * this module turns them back into the matrices `quant-core`'s panel consumer
 * takes. Hand-rolled, like every other CSV read in this repo (vendor-loader,
 * import-databento): the format is ours, it is fixed, and a parser dependency
 * would be a new supply-chain edge for a `split(",")`.
 *
 * Two properties are load-bearing rather than incidental:
 *
 *  - **An empty cell is `null`, never 0.** A2 writes NaN as empty and A3 writes a
 *    non-computable factor value the same way. Reading either as 0 would invent a
 *    signal value at the neutral point of a z-score, i.e. would silently create
 *    observations. `0` in the mask is a real code meaning "evaluated, not U1", so
 *    the two must not be conflated in either direction.
 *  - **Column order is the panel's, and the mask and every signals file are
 *    aligned to it by POSITION.** The symbol axis is read once from the panel's
 *    `close.csv` and asserted against each other file, because a signals file
 *    whose header drifted would otherwise be read against the wrong symbols —
 *    a wrong answer with no error.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Market } from "@agentic-trading/quant-core";
import type { MaskMatrix, NumberMatrix } from "@agentic-trading/quant-core";

export interface PanelManifestLite {
  market: Market;
  fingerprint?: string;
  panelRange?: { start: string; end: string; sessions: number };
  replayWindow?: { start: string; end: string; sessions: number };
  adjustment?: { futureDividendFactor?: { symbols: number; median: number; p10: number; p90: number; max: number } };
}

export interface BridgeManifestLite {
  bridgeVersion?: string;
  zoo?: { digest?: string; gitRevision?: string | null; loaded?: number };
  runtime?: Record<string, unknown>;
  alphas?: { id: string; firstNonNaNSession?: string | null; declaredMinWarmupBars?: number | null }[];
  skipped?: { id: string; error: string; reason: string }[];
}

/** Split one CSV row. The format contains no quoted fields, so a plain split is
 *  exactly right — and asserting that keeps it right if the writer ever changes. */
function cells(line: string): string[] {
  return line.split(",");
}

export function readCsvHeader(file: string): { symbols: string[]; rows: number } {
  const text = readFileSync(file, "utf8");
  const nl = text.indexOf("\n");
  const header = cells(nl === -1 ? text : text.slice(0, nl));
  requireDateColumn(file, header[0]);
  const rows = text.split("\n").filter((l) => l.length > 0).length - 1;
  return { symbols: header.slice(1), rows };
}

function requireDateColumn(file: string, first: string | undefined): void {
  if (first !== "date") throw new Error(`${file}: expected a "date" first column, got "${first ?? ""}"`);
}

function readWide(file: string, parse: (raw: string) => number | null): { symbols: string[]; dates: string[]; values: (number | null)[][] } {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const header = cells(lines[0]!);
  // Checked HERE rather than only in a helper: reading a headerless file against
  // the wrong axis is exactly the confident-wrong-answer this module guards
  // against, and an unchecked path is not a guard.
  requireDateColumn(file, header[0]);
  const symbols = header.slice(1);
  const dates: string[] = [];
  const values: (number | null)[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    const row = cells(line);
    dates.push(row[0]!);
    const out = new Array<number | null>(symbols.length);
    for (let s = 0; s < symbols.length; s++) out[s] = parse(row[s + 1] ?? "");
    values.push(out);
  }
  return { symbols, dates, values };
}

/** A price/signal matrix: empty ⇒ null (see the module note). */
export function readNumberCsv(file: string): NumberMatrix {
  return readWide(file, (raw) => (raw === "" ? null : Number(raw)));
}

/** The eligibility mask: 0 | 1 | 2 inside the replay window, empty outside it.
 *  Empty must stay null — "not evaluated" is not "not eligible". */
export function readMaskCsv(file: string): MaskMatrix {
  const parsed = readWide(file, (raw) => {
    if (raw === "") return null;
    const v = Number(raw);
    if (v !== 0 && v !== 1 && v !== 2) throw new Error(`${file}: mask value ${raw} is not 0, 1 or 2`);
    return v;
  });
  return { dates: parsed.dates, symbols: parsed.symbols, values: parsed.values as (0 | 1 | 2 | null)[][] };
}

/** Assert that a signals file is on the panel's own symbol axis, in order. */
export function assertAligned(what: string, got: { symbols: string[]; dates: string[] }, want: { symbols: string[]; dates: string[] }): void {
  if (got.symbols.length !== want.symbols.length) {
    throw new Error(`${what}: ${got.symbols.length} symbol columns, panel has ${want.symbols.length}`);
  }
  for (let i = 0; i < want.symbols.length; i++) {
    if (got.symbols[i] !== want.symbols[i]) throw new Error(`${what}: column ${i} is ${got.symbols[i]}, panel has ${want.symbols[i]}`);
  }
  if (got.dates.length !== want.dates.length || got.dates[0] !== want.dates[0] || got.dates[got.dates.length - 1] !== want.dates[want.dates.length - 1]) {
    throw new Error(`${what}: ${got.dates.length} sessions (${got.dates[0]}…${got.dates[got.dates.length - 1]}), panel has ${want.dates.length} (${want.dates[0]}…${want.dates[want.dates.length - 1]})`);
  }
}

/** Newest panel directory for a lane, or the explicitly named one. */
export function resolvePanelDir(root: string, market: Market, explicit?: string): string {
  if (explicit) {
    const dir = path.resolve(explicit);
    const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as PanelManifestLite;
    if (manifest.market !== market) throw new Error(`${dir} is a ${manifest.market} panel, but the lane is ${market}`);
    return dir;
  }
  const prefix = `${market.toLowerCase()}-`;
  const candidates = readdirSync(root)
    .filter((n) => n.startsWith(prefix))
    .map((n) => path.join(root, n))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  if (candidates.length === 0) throw new Error(`no ${market} panel under ${root} — run \`pnpm -C apps/api panel:export\``);
  // The fingerprint embeds the panel's own end date, so the newest end wins;
  // ties are impossible because the end date is part of the name.
  candidates.sort();
  return candidates[candidates.length - 1]!;
}

export interface LoadedPanel {
  dir: string;
  market: Market;
  manifest: PanelManifestLite;
  /** Dividend-adjusted close, the forward-return source. */
  close: NumberMatrix;
  mask: MaskMatrix;
  bridge: BridgeManifestLite | null;
  signalsDir: string;
}

export function loadPanel(root: string, market: Market, explicit?: string): LoadedPanel {
  const dir = resolvePanelDir(root, market, explicit);
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as PanelManifestLite;
  const close = readNumberCsv(path.join(dir, "close.csv"));
  const mask = readMaskCsv(path.join(dir, "eligible.csv"));
  assertAligned(`${dir}/eligible.csv`, mask, close);
  const signalsDir = path.join(dir, "signals");
  let bridge: BridgeManifestLite | null = null;
  try {
    bridge = JSON.parse(readFileSync(path.join(signalsDir, "bridge-manifest.json"), "utf8")) as BridgeManifestLite;
  } catch {
    bridge = null;
  }
  return { dir, market, manifest, close, mask, bridge, signalsDir };
}

/** Alpha ids with a signals file, sorted. The bridge's own manifest is the
 *  authority when present — a stray CSV is not evidence that an alpha ran. */
export function availableSignals(panel: LoadedPanel): string[] {
  if (panel.bridge?.alphas?.length) return panel.bridge.alphas.map((a) => a.id).sort();
  try {
    return readdirSync(panel.signalsDir)
      .filter((n) => n.endsWith(".csv"))
      .map((n) => n.slice(0, -4))
      .sort();
  } catch {
    return [];
  }
}
