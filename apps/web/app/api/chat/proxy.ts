/**
 * Shared upstream proxy helper for the chat route handlers (phase-3b §"Web
 * UI"). Browser → Next route handler → Nest at API_INTERNAL_URL (read at
 * request time); the browser never sees the api origin. Never throws: env
 * unset → 503, upstream unreachable → 502, otherwise the upstream status and
 * body are forwarded verbatim.
 */
export function upstreamBase(): string | null {
  return process.env.API_INTERNAL_URL ?? null;
}

export function notConfigured(): Response {
  return Response.json({ error: "api not configured (API_INTERNAL_URL unset)" }, { status: 503 });
}

export function unreachable(): Response {
  return Response.json({ error: "api unreachable" }, { status: 502 });
}

/** Forward a JSON request and relay the upstream response (status + body). */
export async function proxyJson(path: string, init?: RequestInit): Promise<Response> {
  const base = upstreamBase();
  if (!base) return notConfigured();
  let upstream: Response;
  try {
    upstream = await fetch(`${base}${path}`, { ...init, cache: "no-store" });
  } catch {
    return unreachable();
  }
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
  });
}
