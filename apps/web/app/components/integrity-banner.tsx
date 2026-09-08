import type { IntegrityHeader } from "../types";

/**
 * Data-integrity header for a lane (architecture §5 step 5): screened /
 * excluded counts on one line, plus a red banner with warnings when the run
 * was degraded.
 */
export function IntegrityBanner({ integrity }: { integrity: IntegrityHeader }) {
  const excluded = integrity.genuinelyAbsent + integrity.fetchFailed;
  return (
    <div data-testid="integrity-banner">
      <p className="integrity-line">
        screened {integrity.universeSize} · ok {integrity.ok} · excluded {excluded}
        {integrity.fetchFailed > 0 && ` (fetch failed ${integrity.fetchFailed})`}
      </p>
      {integrity.degraded && (
        <div className="banner-degraded" role="alert" data-testid="degraded-banner">
          <strong>degraded run</strong> — treat scores with caution
          {integrity.warnings.length > 0 && (
            <ul>
              {integrity.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
