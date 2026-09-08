"use client";

import type {
  CompareSymbolRow,
  DailyReport,
  DeepDiveIndex,
  FullTranscriptEntry,
  PriceHistory,
  RunSummary,
} from "../types";
import { RatingBadge } from "../components/rating-badge";
import { ConvictionBar } from "../components/conviction-bar";
import { WatchlistTable } from "../components/watchlist-table";
import { PriceChart } from "../components/price-chart";

/** Tool results arrive inside role="tool" messages wrapped as
 *  `<tool-data name="…">…json…</tool-data>` (phase-3b injection posture). */
export function parseToolData(content: string): { name: string; data: unknown } | null {
  const m = /<tool-data name="([^"]+)">([\s\S]*?)<\/tool-data>/.exec(content);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  try {
    return { name: m[1], data: JSON.parse(m[2]) };
  } catch {
    return null;
  }
}

function RawFallback({ name, content }: { name: string; content: string }) {
  return (
    <details className="tool-card" data-testid="tool-card-raw">
      <summary>
        <span className="meta">{name} (raw)</span>
      </summary>
      <pre>{content}</pre>
    </details>
  );
}

function DailyReportCard({ report }: { report: DailyReport }) {
  return (
    <div className="tool-card" data-testid="tool-card-daily">
      <p className="integrity-line">
        {report.market} daily · run {report.run.id} · {new Date(report.run.runAt).toLocaleString("en-GB", { hour12: false })}
        {report.integrity.degraded && " · integrity degraded"}
      </p>
      <WatchlistTable rows={report.rows} runId={report.run.id} />
    </div>
  );
}

function CompareCard({ rows }: { rows: CompareSymbolRow[] }) {
  return (
    <div className="tool-card" data-testid="tool-card-compare">
      <table className="watchlist">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Lane</th>
            <th>Rank</th>
            <th>Score</th>
            <th>Rating</th>
            <th>Conviction</th>
            <th>Thesis</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol}>
              <td>{r.symbol}</td>
              <td>{r.market}</td>
              <td className="num">{r.screen ? r.screen.rank : "—"}</td>
              <td className="num">{r.screen ? r.screen.score.toFixed(2) : "—"}</td>
              <td>
                <RatingBadge rating={r.verdict?.rating ?? null} />
              </td>
              <td>
                {r.verdict ? <ConvictionBar value={r.verdict.conviction} /> : <span className="conviction-value">—</span>}
              </td>
              <td className="thesis" title={r.verdict?.thesis ?? ""}>
                {r.verdict?.thesis ?? "no verdict"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeepDiveCard({ report }: { report: DeepDiveIndex }) {
  const v = report.verdict;
  return (
    <div className="tool-card" data-testid="tool-card-deepdive">
      <p className="integrity-line">
        {report.symbol} · run {report.run.id} ({report.run.market}) · deep-dive {report.status}
      </p>
      {v ? (
        <section className="card" data-testid="verdict-card">
          <div className="lane-header">
            <RatingBadge rating={v.rating} />
            {v.abstain && (
              <span className="badge badge--abstain" data-testid="abstain-badge">
                abstain
              </span>
            )}
            <ConvictionBar value={v.conviction} />
            <span className="meta">
              as of {v.asOf} · {v.promptVersion}
            </span>
          </div>
          <p>{v.thesis}</p>
        </section>
      ) : (
        <p className="notice">no verdict — deep-dive {report.status}</p>
      )}
      <details>
        <summary>
          <span className="meta">transcript index ({report.index.length} entries)</span>
        </summary>
        <ul>
          {report.index.map((e) => (
            <li key={e.hash}>
              <strong>{e.agent}</strong>{" "}
              <span className="meta">
                {e.model} · {e.promptVersion} · {e.hash.slice(0, 12)}
              </span>
              <br />
              <span className="meta">{e.preview}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function PriceHistoryCard({ history }: { history: PriceHistory }) {
  return (
    <div className="tool-card" data-testid="tool-card-price">
      <p className="integrity-line">
        {history.symbol} · adjusted close, {history.days}d
      </p>
      <div className="chart-box">
        <PriceChart bars={history.bars} markers={history.markers} />
      </div>
    </div>
  );
}

function TranscriptEntryCard({ entry }: { entry: FullTranscriptEntry }) {
  return (
    <details className="tool-card" data-testid="tool-card-transcript">
      <summary>
        <strong>{entry.agent}</strong>{" "}
        <span className="meta">
          {entry.model} · {entry.promptVersion} · {entry.hash.slice(0, 12)}
        </span>
      </summary>
      <pre data-testid="system-prompt">{entry.systemPrompt}</pre>
      <pre data-testid="user-prompt">{entry.userPrompt}</pre>
      <pre data-testid="response-text">{entry.responseText}</pre>
    </details>
  );
}

function RunsCard({ runs }: { runs: RunSummary[] }) {
  return (
    <div className="tool-card" data-testid="tool-card-runs">
      <table className="watchlist">
        <thead>
          <tr>
            <th>Run</th>
            <th>When</th>
            <th>Lane</th>
            <th>topN</th>
            <th>LLM calls</th>
            <th>Failed</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td className="num">{r.id}</td>
              <td>{new Date(r.runAt).toLocaleString("en-GB", { hour12: false })}</td>
              <td>{r.market}</td>
              <td className="num">{r.topN}</td>
              <td className="num">{r.llmCalls}</td>
              <td className="num">{r.failed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Renders one persisted role="tool" message as an inline card keyed off the
 *  tool name. Unknown tools and unparseable payloads degrade to a collapsed
 *  raw-JSON details — the message list never breaks. */
export function ToolCard({ toolName, content }: { toolName: string | null; content: string }) {
  const parsed = parseToolData(content);
  if (!parsed) return <RawFallback name={toolName ?? "tool"} content={content} />;
  switch (parsed.name) {
    case "getDailyReport":
      return <DailyReportCard report={parsed.data as DailyReport} />;
    case "compareSymbols":
      return <CompareCard rows={(parsed.data as { symbols: CompareSymbolRow[] }).symbols} />;
    case "getDeepDive":
      return <DeepDiveCard report={parsed.data as DeepDiveIndex} />;
    case "getPriceHistory":
      return <PriceHistoryCard history={parsed.data as PriceHistory} />;
    case "getTranscriptEntry":
      return <TranscriptEntryCard entry={parsed.data as FullTranscriptEntry} />;
    case "listRuns":
      return <RunsCard runs={parsed.data as RunSummary[]} />;
    default:
      return <RawFallback name={parsed.name} content={JSON.stringify(parsed.data, null, 2)} />;
  }
}
