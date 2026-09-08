import { notConfigured, unreachable } from "../../../proxy";

/**
 * POST /api/chat/sessions/:id/messages — SSE passthrough. The upstream body
 * is streamed through unbuffered (ReadableStream passthrough) with
 * Content-Type: text/event-stream. HTTP errors thrown by the api before the
 * stream opens (400/404/503) are relayed with their status and JSON body.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const base = process.env.API_INTERNAL_URL;
  if (!base) return notConfigured();
  const { id } = await params;
  const body = await req.text();
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/chat/sessions/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
    });
  } catch {
    return unreachable();
  }
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
