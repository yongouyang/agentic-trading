import Link from "next/link";
import { ChatApp } from "./chat-app";

export const dynamic = "force-dynamic";

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ symbol?: string }> }) {
  const { symbol } = await searchParams;
  return (
    <main>
      <div className="lane-header">
        <h1>chat</h1>
        <span className="meta">
          <Link href="/">← dashboard</Link>
        </span>
      </div>
      <ChatApp initialInput={symbol ? `Tell me about ${symbol}` : ""} />
    </main>
  );
}
