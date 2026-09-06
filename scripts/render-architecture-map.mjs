#!/usr/bin/env node
// docs/architecture-map.md -> docs/architecture-map.html (mermaid via CDN).
// Single source of truth is the .md; rerun this after editing it.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const md = await readFile(join(root, "docs/architecture-map.md"), "utf8");

const blocks = [];
const re = /^#{2,3} (.+)\n([\s\S]*?)```mermaid\n([\s\S]*?)```/gm;
for (const m of md.matchAll(re)) blocks.push({ title: m[1], body: m[2].trim(), code: m[3] });

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The system map is the wall diagram: render it at natural size with bigger
// type instead of letting mermaid shrink it to fit the container.
const scale = (title, code) =>
  /system map/i.test(title)
    ? `%%{init: {'flowchart':{'useMaxWidth':false},'themeVariables':{'fontSize':'20px'}}}%%\n` + code
    : code;

const sections = blocks
  .map(
    (b) => `<section>
    <h2>${esc(b.title)}</h2>
    ${b.body ? `<p>${esc(b.body).replace(/\n/g, "<br>")}</p>` : ""}
    <pre class="mermaid">${esc(scale(b.title, b.code))}</pre>
  </section>`
  )
  .join("\n");

await writeFile(
  join(root, "docs/architecture-map.html"),
  `<!doctype html>
<meta charset="utf-8">
<title>agentic-trading — architecture map</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 2100px; margin: 2rem auto; padding: 0 1.5rem;
         font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size: 1.5rem; }
  h2 { font-size: 1.2rem; margin-top: 2.5rem; }
  p, li { color: #555; }
  .mermaid { background: #fff; border: 1px solid #ddd; border-radius: 8px;
             padding: 1rem; overflow-x: auto; text-align: center; }
  .mermaid svg { max-width: 100%; height: auto; }
  footer { margin: 3rem 0; font-size: .85rem; }
</style>
<body>
<h1>agentic-trading — architecture map</h1>
<p>Generated from <code>docs/architecture-map.md</code> by <code>scripts/render-architecture-map.mjs</code>.
   Solid = shipped · dashed = designed · P2/P3/P4 = phase.</p>
${sections}
<footer>Source: <code>docs/architecture-map.md</code> · authoritative design:
  <code>docs/architecture-v1.md</code></footer>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: true, theme: "default", securityLevel: "loose" });
</script>
</body>
`
);
console.log(`wrote docs/architecture-map.html (${blocks.length} diagrams)`);
