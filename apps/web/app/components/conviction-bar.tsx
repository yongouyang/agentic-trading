/**
 * Diverging bar for conviction ∈ [-1, 1]: fills right of center (green) for
 * positive, left of center (red) for negative, empty with a center tick at 0.
 */
export function ConvictionBar({ value }: { value: number }) {
  const clamped = Math.max(-1, Math.min(1, value));
  const pct = (Math.abs(clamped) / 2) * 100;
  const pos = clamped > 0;
  const neg = clamped < 0;
  return (
    <div className="conviction" data-testid="conviction-bar" data-value={clamped}>
      <div className="conviction-track">
        <div className="conviction-zero" />
        {pos && (
          <div
            data-testid="conviction-fill"
            className="conviction-fill conviction-fill--pos"
            style={{ left: "50%", width: `${pct}%` }}
          />
        )}
        {neg && (
          <div
            data-testid="conviction-fill"
            className="conviction-fill conviction-fill--neg"
            style={{ right: "50%", width: `${pct}%` }}
          />
        )}
      </div>
      <span className="conviction-value">{clamped.toFixed(2)}</span>
    </div>
  );
}
