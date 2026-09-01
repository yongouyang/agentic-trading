/**
 * ApiHealth — minimal server component proving the web app can reach the api.
 * Reads API_INTERNAL_URL (server-only); renders a typed status line, never
 * throws — an unreachable api renders "api: unreachable".
 */
export async function ApiHealth() {
  const base = process.env.API_INTERNAL_URL;
  if (!base) {
    return <p data-testid="api-health">api: not configured</p>;
  }
  try {
    const res = await fetch(`${base}/health`, { cache: "no-store" });
    if (!res.ok) throw new Error(`health returned ${res.status}`);
    const body = (await res.json()) as { status: string; instruments: number };
    return (
      <p data-testid="api-health">
        api: {body.status} (instruments: {body.instruments})
      </p>
    );
  } catch {
    return <p data-testid="api-health">api: unreachable</p>;
  }
}
