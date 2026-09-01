import { ApiHealth } from "./api-health";

// ApiHealth reads API_INTERNAL_URL at request time — never prerender.
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <main>
      <h1>agentic-trading</h1>
      <p>Phase 0 scaffold — chat session and daily report land in Phase 3.</p>
      <ApiHealth />
    </main>
  );
}
