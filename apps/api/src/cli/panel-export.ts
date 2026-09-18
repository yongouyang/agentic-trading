/**
 * `panel:export` — Phase 6A A2 runner (docs/phase-6a-plan.md).
 *
 * Store (read-only) → `apps/api/reports/factor-panels/<lane>-<fingerprint>/`
 * wide panels + the U1/U2 mask + a manifest. No statistics, no returns: this is
 * the input side of 6A, and the bridge (A3) may only compute signal panels from
 * it.
 *
 * Idempotent by construction: the fingerprint is derived from the panel's own
 * range and contents, `generatedAt` is preserved from the first export, and each
 * file is written only when its bytes change — so re-running is a no-op that
 * proves the inputs did not move.
 *
 * Usage:
 *   pnpm -C apps/api panel:export [--market us|hk|all] [--json] [--quiet]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Market } from "@agentic-trading/quant-core";
import { PrismaService } from "../prisma.service.js";
import { exportPanel, renderPanelSummary, type PanelExportResult } from "../backtest/panel-export.js";

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
export const PANEL_ROOT = path.join(PKG_ROOT, "reports", "factor-panels");

export interface PanelArgs {
  markets: Market[];
  quiet: boolean;
}

export function parsePanelArgs(argv: string[]): PanelArgs {
  let markets: Market[] = ["US", "HK"];
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue; // pnpm passes a bare --
    if (arg === "--quiet") {
      quiet = true;
      continue;
    }
    if (arg === "--json") continue; // the manifest IS the json artifact
    if (arg === "--market") {
      const v = argv[++i];
      if (v === "all") markets = ["US", "HK"];
      else if (v === "us") markets = ["US"];
      else if (v === "hk") markets = ["HK"];
      else throw new Error(`--market must be us|hk|all, got "${v ?? ""}"`);
      continue;
    }
    throw new Error(`unknown argument "${arg}" (expected --market us|hk|all, --quiet)`);
  }
  return { markets, quiet };
}

export async function runPanelExportCli(
  prisma: PrismaService,
  args: PanelArgs,
  log: (m: string) => void = () => {},
): Promise<PanelExportResult[]> {
  const out: PanelExportResult[] = [];
  for (const market of args.markets) {
    log(`  ${market}: loading store (read-only)…`);
    out.push(await exportPanel(prisma, market, { root: PANEL_ROOT, log }));
  }
  return out;
}

async function main(): Promise<void> {
  const args = parsePanelArgs(process.argv.slice(2));
  const log = args.quiet ? () => {} : (m: string) => console.error(m);

  const prisma = new PrismaService();
  await prisma.$connect();
  let results: PanelExportResult[];
  try {
    results = await runPanelExportCli(prisma, args, log);
  } finally {
    await prisma.$disconnect();
  }

  const text = results.map(renderPanelSummary).join("\n\n");
  console.log(text);

  mkdirSync(PANEL_ROOT, { recursive: true });
  // Write-if-changed like the panel files, so a re-export leaves the whole
  // output directory untouched (mtime included) rather than only its contents.
  const indexFile = path.join(PANEL_ROOT, "index.txt");
  const indexText = `${text}\n`;
  try {
    if (readFileSync(indexFile, "utf8") !== indexText) writeFileSync(indexFile, indexText);
  } catch {
    writeFileSync(indexFile, indexText);
  }
  log(`panels → apps/api/reports/factor-panels/`);
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (invokedAsScript) {
  main().catch((e) => {
    console.error("FATAL", e);
    process.exit(1);
  });
}
