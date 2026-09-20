import Link from "next/link";
import type { WatchlistRow } from "../types";
import { RatingBadge } from "./rating-badge";
import { ConvictionBar } from "./conviction-bar";

function thesisCell(row: WatchlistRow): string {
  if (row.verdict) return row.verdict.thesis;
  if (row.deepDiveStatus?.startsWith("failed:")) return `deep-dive failed (${row.deepDiveStatus.slice(7)})`;
  return "not deep-dived";
}

export function WatchlistTable({ rows, runId }: { rows: WatchlistRow[]; runId: number }) {
  return (
    <table className="watchlist" data-testid="watchlist-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Symbol</th>
          <th>Score</th>
          <th title="Phase-7 trend gates: G1 close ≥ 200d MA · G2 12M return > 0 (display only)">Gates</th>
          <th>Rating</th>
          <th>Conviction</th>
          <th>Thesis</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const failed = row.deepDiveStatus?.startsWith("failed:") ?? false;
          return (
            <tr key={row.symbol} className={failed ? "row-failed" : undefined}>
              <td className="num">{row.rank}</td>
              <td>
                <Link href={`/symbol/${encodeURIComponent(row.symbol)}?run=${runId}`}>{row.symbol}</Link>
                {row.metrics.caDegraded && <span title="corporate-action degraded"> ⚠</span>}
              </td>
              <td className="num">{row.score.toFixed(2)}</td>
              <td className="num" title="G1: close vs 200d MA · G2: 12M return (blank = insufficient history)">
                {row.metrics.gateG1 == null ? "—" : row.metrics.gateG1 ? "G1✓" : "G1✗"}{" "}
                {row.metrics.gateG2 == null ? "—" : row.metrics.gateG2 ? "G2✓" : "G2✗"}
              </td>
              <td>
                <RatingBadge rating={row.verdict?.rating ?? null} />
              </td>
              <td>
                {row.verdict ? (
                  <ConvictionBar value={row.verdict.conviction} />
                ) : (
                  <span className="conviction-value">—</span>
                )}
              </td>
              <td className="thesis" title={thesisCell(row)}>
                {thesisCell(row)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
