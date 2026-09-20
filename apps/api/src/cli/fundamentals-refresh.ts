/**
 * `pnpm -C apps/api fundamentals:refresh -- --market us|hk|all`
 *
 * Phase 7 (docs/phase-7-plan.md §2): ingest PIT fundamental points for every
 * stored name and print the coverage report that is the step's exit criterion
 * (US ≥95% of names with ≥8 quarter/annual revenue periods; HK ≥90% with ≥4
 * semi/annual). Idempotent: a symbol's points for its source are rewritten.
 */
import { PrismaService } from "../prisma.service.js";
import { computeCoverage, runIngest } from "../fundamentals/ingest.js";

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
      console.log(`== fundamentals:refresh ${market} == ${symbols.length} stored names`);
      const summary = await runIngest(prisma, market, symbols);
      console.log(
        `ingest: ${summary.ok}/${summary.attempted} names ok · ${summary.points} points` +
          (summary.failed.length ? ` · failed: ${summary.failed.map((f) => `${f.symbol}(${f.failure})`).join(", ")}` : ""),
      );
      const stored = await prisma.fundamentalPoint.findMany({
        where: { market },
        select: { symbol: true, metric: true, periodEnd: true, periodType: true },
      });
      // Amendment (2026-09-20): the coverage criterion applies to REPORTING
      // entities — names with ≥1 stored fundamental point. ETFs and delisted
      // names have no statements by nature (US: no-cik/http-404; HK: empty
      // F10 report) and can never meet the bar; they are listed, not counted.
      const reporting = [...new Set(stored.map((p) => p.symbol))];
      const nonReporting = symbols.filter((s) => !reporting.includes(s));
      const cov = computeCoverage(stored, reporting, market);
      const pct = cov.names ? ((100 * cov.meeting) / cov.names).toFixed(1) : "0.0";
      console.log(
        `coverage: ${cov.meeting}/${cov.names} reporting names meet the ${market === "US" ? "≥8 quarter/annual" : "≥4 semi/annual"} revenue-period bar (${pct}%)`,
      );
      console.log(`non-reporting (${nonReporting.length}, excluded from the bar): ${nonReporting.join(", ")}`);
      if (cov.below.length) console.log(`below bar: ${cov.below.join(", ")}`);
      const needed = market === "US" ? 0.95 : 0.9;
      if (cov.names > 0 && cov.meeting / cov.names < needed) {
        console.error(`COVERAGE BELOW THE PLAN'S EXIT CRITERION (${(needed * 100).toFixed(0)}%)`);
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
