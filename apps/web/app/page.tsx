import Link from "next/link";
import { ApiHealth } from "./api-health";
import { LaneSection } from "./components/lane-section";
import { RunPicker } from "./components/run-picker";
import { fetchDailyReport, fetchRuns } from "./lib/api";

// Reads API_INTERNAL_URL at request time — never prerender.
export const dynamic = "force-dynamic";

function parseRunParam(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export default async function Page({ searchParams }: { searchParams: Promise<{ hkRun?: string; usRun?: string }> }) {
  const { hkRun, usRun } = await searchParams;
  const hkRunId = parseRunParam(hkRun);
  const usRunId = parseRunParam(usRun);
  const [hk, us, hkRuns, usRuns] = await Promise.all([
    fetchDailyReport("HK", hkRunId),
    fetchDailyReport("US", usRunId),
    fetchRuns("HK"),
    fetchRuns("US"),
  ]);
  return (
    <main>
      <div className="lane-header">
        <h1>agentic-trading — daily report</h1>
        <span className="meta">
          <Link href="/chat">Chat →</Link>
        </span>
      </div>
      <LaneSection
        market="HK"
        result={hk}
        picker={<RunPicker runs={hkRuns.kind === "ok" ? hkRuns.runs : []} param="hkRun" current={hkRunId} testId="run-picker-HK" />}
      />
      <LaneSection
        market="US"
        result={us}
        picker={<RunPicker runs={usRuns.kind === "ok" ? usRuns.runs : []} param="usRun" current={usRunId} testId="run-picker-US" />}
      />
      <footer>
        <ApiHealth />
      </footer>
    </main>
  );
}
