import type { DailyResult } from "../lib/api";
import { IntegrityBanner } from "./integrity-banner";
import { WatchlistTable } from "./watchlist-table";

/**
 * One lane section (HK or US) of the daily dashboard. Renders one of three
 * states: unreachable api, no run yet (api 404), or the ranked watchlist.
 * The optional `picker` slot (phase-3c run picker) sits in the lane header.
 */
export function LaneSection({ market, result, picker }: { market: "US" | "HK"; result: DailyResult; picker?: React.ReactNode }) {
  return (
    <section className="card" data-testid={`lane-${market}`}>
      <div className="lane-header">
        <h2>{market}</h2>
        {picker}
        {result.kind === "ok" && (
          <span className="meta">
            run {result.report.run.id} · {new Date(result.report.run.runAt).toLocaleString("en-GB", { hour12: false })} ·
            top {result.report.run.topN} deep-dived · {result.report.run.failed} failed
          </span>
        )}
      </div>
      {result.kind === "unreachable" && <p className="notice">api: unreachable</p>}
      {result.kind === "no-run" && <p className="notice">no run yet for {market}</p>}
      {result.kind === "ok" && (
        <>
          <IntegrityBanner integrity={result.report.integrity} />
          <WatchlistTable rows={result.report.rows} runId={result.report.run.id} />
        </>
      )}
    </section>
  );
}
