import { proxyJson } from "../proxy";

/** GET /api/chat/sessions — recent sessions for the resume picker. */
export async function GET(): Promise<Response> {
  return proxyJson("/chat/sessions");
}

/** POST /api/chat/sessions → { id }. 503s upstream when chat env is missing. */
export async function POST(): Promise<Response> {
  return proxyJson("/chat/sessions", { method: "POST" });
}
