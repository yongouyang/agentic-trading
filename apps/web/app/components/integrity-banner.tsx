import type { IntegrityHeader } from "../types";

/**
 * Data-integrity header for a lane (architecture §5 step 5): screened /
 * excluded counts on one line, the effective data cutoff (W3b), plus a red
 * banner with warnings when the run was degraded.
 *
 * The cutoff renders as a bare date here. Judging it stale needs each lane's
 * cadence expectation, which lives in the api's health module (W4) — the
 * dashboard health banner carries that verdict rather than duplicating the
 * weekday arithmetic in a presentational component.
 */
export function IntegrityBanner({ integrity }: { integrity: IntegrityHeader }) {
  const excluded = integrity.genuinelyAbsent + integrity.fetchFailed;
  return (
    <div data-testid="integrity-banner">
      <p className="integrity-line">
        screened {integrity.universeSize} · ok {integrity.ok} · excluded {excluded}
        {integrity.fetchFailed > 0 && ` (fetch failed ${integrity.fetchFailed})`}
        {integrity.dataThrough && ` · data through ${integrity.dataThrough}`}
        {/* Only shown when it adds information: if the list is ranked for the same
            session the data ends at, "data through" already said it. */}
        {integrity.screenedSession && ` · list ranked for ${integrity.screenedSession}`}
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
      {/* Phase 4b item 6. This header otherwise vouches only for the DATA — how
          much was screened and how fresh it is. The rules that turned it into a
          ranking have not been validated, and a reader acting on the list is
          entitled to know that without opening a research document. Absent on
          an older api response, which then renders exactly as before. */}
      {integrity.caveat && (
        <p className="integrity-caveat" data-testid="integrity-caveat">
          {integrity.caveat}
        </p>
      )}
    </div>
  );
}
