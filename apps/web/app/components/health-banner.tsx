import type { HealthReport } from "../types";

/**
 * Pipeline health banner (W4d, docs/ops-hardening-plan.md).
 *
 * The only thing that surfaces a run that died, a lane that went quiet, or data
 * that is behind — launchd records a non-zero exit but tells nobody, and the
 * desktop notification was explicitly declined. Rendered above the lanes so it
 * is visible even when a lane has no report to show at all.
 *
 * Healthy renders nothing (a permanently-visible "all good" line is noise), and
 * an unreachable api renders the quietly-degraded line, matching the lane
 * posture rather than shouting.
 */
export function HealthBanner({ health }: { health: HealthReport | null }) {
  if (!health) {
    return (
      <p className="health-line" data-testid="health-banner">
        pipeline health: unreachable
      </p>
    );
  }

  if (health.level === "healthy") return null;

  const flaggedLanes = health.lanes.filter((l) => l.level !== "healthy");
  const flaggedJobs = health.jobs.filter((j) => j.level !== "healthy");

  return (
    <div className={`banner-health banner-health-${health.level}`} role="alert" data-testid="health-banner">
      <strong>pipeline {health.level}</strong> — check before trusting the watchlist
      <ul>
        {flaggedLanes.map((l) => (
          <li key={l.market}>
            <strong>{l.market}</strong>: data through {l.dataThrough ?? "—"}
            {l.lastCompleteRunId === null
              ? ", no complete run"
              : `, last completed run ${l.lastCompleteRunId} (${l.expectedRunsMissed} scheduled run(s) missed)`}
            {l.reasons.map((r, i) => (
              <div key={i} className="health-reason">
                {r}
              </div>
            ))}
          </li>
        ))}
        {flaggedJobs.map((j) => (
          <li key={j.job}>
            <strong>{j.job}</strong>: last artifact {j.lastArtifactDate ?? "none on record"}
            {j.reasons.map((r, i) => (
              <div key={i} className="health-reason">
                {r}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
