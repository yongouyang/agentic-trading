/**
 * `pnpm -C apps/api sector:refresh -- --market us|hk|all`
 *
 * Phase 7 P2 (docs/phase-7-plan.md §E3): label every stored name with a coarse
 * sector bucket and print the per-bucket histogram — the input to the frozen
 * subgroup list (§5 amendment). Exit 1 if more than 10% of a market's names
 * fail to label (ETFs landing in "Other" do NOT count as failures).
 */
import { PrismaService } from "../prisma.service.js";
import { runSectorRefresh } from "../fundamentals/sector-ingest.js";

function parseArgs(argv: string[]): { markets: ("US" | "HK")[] } {
  let market = "all";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--market") market = (argv[++i] ?? "").toLowerCase();
    else throw new Error(`unknown argument "${a}" (expected --market us|hk|all)`);
  }
  if (!["us", "hk", "all"].includes(market)) throw new Error(`--market must be us|hk|all, got "${market}"`);
  return { markets: market === "all" ? ["US", "HK"] : [market.toUpperCase() as "US" | "HK"] };
}

async function main(): Promise<void> {
  const { markets } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaService();
  await prisma.$connect();
  let worst = 0;
  try {
    for (const market of markets) {
      const instruments = await prisma.instrument.findMany({ where: { market }, select: { symbol: true } });
      const symbols = instruments.map((i) => i.symbol).sort();
      console.log(`== sector:refresh ${market} == ${symbols.length} stored names`);
      const summary = await runSectorRefresh(prisma, market, symbols);
      const histogram = Object.entries(summary.byBucket)
        .sort((a, b) => b[1] - a[1])
        .map(([bucket, n]) => `${bucket}:${n}`)
        .join("  ");
      console.log(`labelled ${summary.labelled}/${summary.attempted} · ${histogram}`);
      // ETFs/delisted names have no SIC by nature (no-cik, no-orgprofile) —
      // expected absence, not a labelling failure (same rule as E1b).
      const realFailures = summary.failed.filter((f) => f.failure !== "no-cik" && f.failure !== "no-orgprofile");
      const absent = summary.failed.length - realFailures.length;
      if (absent > 0) console.log(`non-reporting (${absent}, expected absence — excluded from the failure rate)`);
      if (realFailures.length) {
        console.log(`failed (${realFailures.length}): ${realFailures.map((f) => `${f.symbol}(${f.failure})`).join(", ")}`);
      }
      if (summary.attempted > 0 && realFailures.length / summary.attempted > 0.1) {
        console.error(`LABEL FAILURE RATE ABOVE 10%`);
        worst = 1;
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  process.exit(worst);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
