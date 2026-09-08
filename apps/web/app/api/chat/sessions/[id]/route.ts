import { proxyJson } from "../../proxy";

/** GET /api/chat/sessions/:id — full message history + usage totals. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyJson(`/chat/sessions/${encodeURIComponent(id)}`);
}
