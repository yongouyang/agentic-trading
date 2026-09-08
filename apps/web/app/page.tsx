import Link from "next/link";
import { ApiHealth } from "./api-health";
import { LaneSection } from "./components/lane-section";
import { fetchDailyReport } from "./lib/api";

// Reads API_INTERNAL_URL at request time — never prerender.
export const dynamic = "force-dynamic";

export default async function Page() {
  const [hk, us] = await Promise.all([fetchDailyReport("HK"), fetchDailyReport("US")]);
  return (
    <main>
      <div className="lane-header">
        <h1>agentic-trading — daily report</h1>
        <span className="meta">
          <Link href="/chat">Chat →</Link>
        </span>
      </div>
      <LaneSection market="HK" result={hk} />
      <LaneSection market="US" result={us} />
      <footer>
        <ApiHealth />
      </footer>
    </main>
  );
}
