import type { ReactNode } from "react";

/**
 * Hand-rolled markdown renderer for the assistant-message subset (phase-3b:
 * no new dependencies). Supports paragraphs, #-### headings, **bold**,
 * *italic*, `inline code`, fenced code blocks, unordered/ordered lists, and
 * [links](url). Everything is built as React nodes, so raw HTML in the
 * source is escaped by construction.
 */

const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (tok.startsWith("**")) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("`")) {
      out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("[")) {
      const close = tok.indexOf("](");
      const label = tok.slice(1, close);
      const href = tok.slice(close + 2, -1);
      out.push(
        <a key={key} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    } else {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

interface Block {
  kind: "code" | "heading" | "ul" | "ol" | "p";
  level?: number;
  lines: string[];
}

function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let cur: Block | null = null;
  const flush = () => {
    if (cur && cur.lines.length > 0) blocks.push(cur);
    cur = null;
  };
  let inFence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (inFence) {
        flush();
        inFence = false;
      } else {
        flush();
        cur = { kind: "code", lines: [] };
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      cur!.lines.push(line);
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading && heading[1] !== undefined && heading[2] !== undefined) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, lines: [heading[2]] });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (cur?.kind !== "ul") {
        flush();
        cur = { kind: "ul", lines: [] };
      }
      cur.lines.push(line.replace(/^\s*[-*]\s+/, ""));
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      if (cur?.kind !== "ol") {
        flush();
        cur = { kind: "ol", lines: [] };
      }
      cur.lines.push(line.replace(/^\s*\d+\.\s+/, ""));
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (cur?.kind !== "p") {
      flush();
      cur = { kind: "p", lines: [] };
    }
    cur.lines.push(line);
  }
  flush();
  return blocks;
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case "code":
      return (
        <pre key={key} data-testid="md-code">
          <code>{block.lines.join("\n")}</code>
        </pre>
      );
    case "heading": {
      const Tag = (`h${Math.min(3, block.level ?? 1) + 2}`) as "h3" | "h4" | "h5";
      return <Tag key={key}>{renderInline(block.lines[0] ?? "", `h${key}`)}</Tag>;
    }
    case "ul":
      return (
        <ul key={key}>
          {block.lines.map((l, i) => (
            <li key={i}>{renderInline(l, `ul${key}-${i}`)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={key}>
          {block.lines.map((l, i) => (
            <li key={i}>{renderInline(l, `ol${key}-${i}`)}</li>
          ))}
        </ol>
      );
    case "p":
      return <p key={key}>{renderInline(block.lines.join(" "), `p${key}`)}</p>;
  }
}

export function Markdown({ text }: { text: string }) {
  return <div className="md">{toBlocks(text).map((b, i) => renderBlock(b, i))}</div>;
}
