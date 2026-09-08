import Link from "next/link";
import { RatingBadge } from "../../components/rating-badge";
import { ConvictionBar } from "../../components/conviction-bar";
import { fetchDeepDive, fetchPriceHistory } from "../../lib/api";
import type { DeepDiveReport, TranscriptEntry } from "../../types";
import { PriceChart } from "../../components/price-chart";

export const dynamic = "force-dynamic";

function TranscriptItem({ entry }: { entry: TranscriptEntry }) {
  return (
    <details data-testid="transcript-entry">
      <summary>
        <strong>{entry.agent}</strong>
        <span className="meta">
          {entry.model} · {entry.promptVersion}
          {entry.usage && ` · ${entry.usage.promptTokens}+${entry.usage.completionTokens} tokens`}
        </span>
      </summary>
      <div className="body">
        <details>
          <summary>
            <span className="meta">system prompt</span>
          </summary>
          <div className="body">
            <pre data-testid="system-prompt">{entry.systemPrompt}</pre>
          </div>
        </details>
        <details>
          <summary>
            <span className="meta">user prompt</span>
          </summary>
          <div className="body">
            <pre>{entry.userPrompt}</pre>
          </div>
        </details>
        <details open={entry.agent === "verdict"}>
          <summary>
            <span className="meta">response</span>
          </summary>
          <div className="body">
            <pre data-testid="response-text">{entry.responseText}</pre>
          </div>
        </details>
      </div>
    </details>
  );
}

function VerdictCard({ report }: { report: DeepDiveReport }) {
  const v = report.verdict;
  if (!v) {
    return (
      <section className="card" data-testid="verdict-card">
        <p className="notice">no verdict — deep-dive {report.status}</p>
      </section>
    );
  }
  return (
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
      <div className="verdict-grid">
        <div>
          <h2>Key risks</h2>
          <ul>
            {v.keyRisks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
        <div>
          <h2>Invalidation conditions</h2>
          <ul>
            {v.invalidationConditions.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export default async function SymbolPage({
  params,
  searchParams,
}: {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const { symbol } = await params;
  const { run } = await searchParams;
  const runId = Number(run);

  if (!run || Number.isNaN(runId)) {
    return (
      <main>
        <h1>{symbol}</h1>
        <p className="notice">invalid link — a run id is required (?run=&lt;id&gt;).</p>
      </main>
    );
  }

  const [dd, ph] = await Promise.all([fetchDeepDive(runId, symbol), fetchPriceHistory(symbol)]);

  if (dd.kind === "unreachable") {
    return (
      <main>
        <h1>{symbol}</h1>
        <p className="notice">api: unreachable</p>
      </main>
    );
  }
  if (dd.kind === "not-found") {
    return (
      <main>
        <h1>{symbol}</h1>
        <p className="notice">no deep-dive found for {symbol} in run {runId}.</p>
      </main>
    );
  }

  const report = dd.report;
  return (
    <main>
      <div className="lane-header">
        <h1>
          {report.symbol} <span className="meta">{report.run.market}</span>
        </h1>
        <span className="meta">
          run {report.run.id} · {new Date(report.run.runAt).toLocaleString("en-GB", { hour12: false })}
        </span>
        <span className="meta">
          <Link href={`/chat?symbol=${encodeURIComponent(report.symbol)}`}>Chat →</Link>
        </span>
      </div>
      <VerdictCard report={report} />
      <section>
        <h2>Price — adjusted close, 250d</h2>
        {ph.kind === "ok" ? (
          <div className="chart-box">
            <PriceChart bars={ph.history.bars} markers={ph.history.markers} />
          </div>
        ) : (
          <p className="notice" data-testid="chart-unavailable">
            price history unavailable{ph.kind === "unreachable" ? " (api: unreachable)" : ""}
          </p>
        )}
      </section>
      <section className="transcript">
        <h2>Transcript ({report.transcript.length} agent calls)</h2>
        {report.transcript.map((entry) => (
          <TranscriptItem key={entry.hash} entry={entry} />
        ))}
      </section>
    </main>
  );
}
