# Architecture Map — as-built + evolution path

Rendered: [`architecture-map.html`](./architecture-map.html) (mermaid via CDN,
regenerate with `pnpm docs:map` after editing this file).

Archify version (validated standalone HTML, self-contained — no CDN):
[`architecture-system-map.html`](./architecture-system-map.html), source
[`architecture-system-map.json`](./architecture-system-map.json). Rebuild with
`node ~/.agents/skills/archify/bin/archify.mjs deliver architecture <spec.json> <out.html> --quality showcase`.

Reference diagram set for `architecture-v1.md` (§1 objective, §3 layout, §5
pipeline, §10 build order). Complements, does not replace it.

Legend: **solid** = shipped · **dashed** = designed, not built ·
`P2`/`P3`/`P4` = phase it lands in.

---

## 1. System map (the one to keep on the wall)

```mermaid
flowchart TB
    subgraph EXT["External (free, no-key)"]
        YH["Yahoo v8 chart<br/>SOLE daily feed · US + HK"]
        EM["eastmoney F10<br/>CA correction overlay · statements"]
        GN["Google News RSS<br/>+ Yahoo news (P2)"]
        TC["tencent / eastmoney push2his<br/>repair only · HK raw bars"]
        DB["Databento batch<br/>one-off US archive (done)"]
    end

    subgraph ING["apps/api — ingestion & quality"]
        LOAD["market-data providers<br/>pinned UA · 200ms spacing"]
        DQ["Day-17 quality gate<br/>7 checks → DataOutcome"]
        CA["Corporate actions<br/>DIVIDEND / SPLIT / IN_SPECIE"]
        CLI["CLIs: screen:daily · screen:sentinel<br/>repair:store · ca:f10-refresh"]
    end

    subgraph QC["packages/quant-core — TRUSTED (deterministic)"]
        ADJ["adjustment.ts<br/>R1: store raw, derive adjusted"]
        IND["indicators.ts<br/>trend / momentum / vol"]
        SCR["screening.ts<br/>rank → top 10-15 per lane"]
        DQ2["data-quality.ts · calendars.ts"]
    end

    subgraph AG["packages/agents — PROPOSES (never authoritative) · P2"]
        CTX["context.ts<br/>DeepDiveContext assembly"]
        NA["news / fundamentals analyst<br/>(parallel · ETFs: news only)"]
        DEB["bull vs bear debate<br/>2 rounds"]
        VER["verdict.ts<br/>5-tier + conviction + abstain"]
        LOG["AgentDecision<br/>sha256(agent|model|pv|prompts)"]
    end

    subgraph ST["SQLite (Prisma)"]
        B[(Bar · Instrument<br/>CorporateAction · SplitEvent)]
        V[(VendorBar · VendorSegment<br/>VendorInstrument)]
        S[(ScreenRun · ScreenResult)]
        D[(DeepDiveRun · DeepDiveReport<br/>AgentDecision · P2)]
    end

    subgraph UI["apps/web — Next.js · P3"]
        CHAT["Chat session (centerpiece)<br/>drill / challenge / compare"]
        RPT["Daily report view<br/>ranked watchlist + transcripts"]
        CH["lightweight-charts"]
    end

    YH --> LOAD --> DQ --> B
    EM --> CA --> B
    DB --> V
    TC --> LOAD
    B --> ADJ --> IND --> SCR --> S
    CA --> ADJ
    DQ2 --> DQ
    S --> CTX
    GN --> CTX
    B --> CTX
    CTX --> NA --> DEB --> VER --> LOG --> D
    VER -.->|"advisory only"| S
    S --> RPT
    D --> RPT
    D --> CHAT
    B --> CH --> CHAT
    CLI --> LOAD

    classDef built fill:#e8f4ea,stroke:#2d6a4f
    classDef planned fill:#fdf6e3,stroke:#b08968,stroke-dasharray:4 3
    class YH,EM,TC,DB,LOAD,DQ,CA,CLI,ADJ,IND,SCR,DQ2,B,V,S,CH built
    class GN,CTX,NA,DEB,VER,LOG,D,CHAT,RPT planned
```

**The rule the diagram encodes:** arrows from `packages/agents` point *into*
storage, never into `quant-core`. Agents propose, the quant core disposes.

---

## 2. Daily data flow (two runs: ~16:45 HKT HK · ~06:00 HKT US)

```mermaid
flowchart LR
    A["1 · Ingest<br/>raw OHLCV + CA<br/>~800 tickers"] --> B["2 · Quality gate<br/>OK / GENUINE_ABSENT<br/>/ FETCH_FAILED"]
    B -->|"FETCH_FAILED ≠ no opportunity<br/>→ run marked degraded"| C["3 · Re-derive<br/>adjusted series (R1)"]
    B -->|"repair path: raw only, R3"| A
    C --> D["4 · Technical screen<br/>trend · momentum · volume · vol<br/>→ top 10–15 / lane"]
    D --> E["5 · Deep-dive (P2)<br/>top 10 / lane · 6–8 calls<br/>cache hit = $0"]
    E --> F["6 · Persist + report<br/>data-integrity header first"]
    F --> G["7 · User reads, trades manually<br/>(no broker in v1)"]
    D -->|"P3"| F
    G -.->|"P4: backtest the screen<br/>itself, OOS discipline"| D
```

Data-integrity header (leads every report): *"782/800 screened; 11 Yahoo 429s
retried; 7 halted; 3 excluded for bad adjustments."*

---

## 3. Evolution path

```mermaid
flowchart TB
    P0["Phase 0 — DONE<br/>scaffold · ingestion · quality report<br/>gate: Yahoo verified for HK + US"]
    P1["Phase 1 — DONE (+hardening)<br/>quant-core indicators · screening · screen:daily CLI<br/>sentinel green · F10 CA overlay · Databento archive"]
    P2["Phase 2 — NEXT<br/>agents pipeline · DeepDiveRun/Report<br/>AgentDecision cache+audit · screen:deep-dive"]
    P3["Phase 3<br/>Next.js chat + daily report view<br/>charts · transcripts"]
    P4["Phase 4<br/>backtest the screen · param iteration<br/>train/OOS · Day 21-23 engine"]
    P5["Later<br/>broker: Futu / IBKR<br/>paper → live"]

    P0 --> P1 --> P2 --> P3 --> P4 --> P5
```

What each phase adds to the map, in one line:

| Phase | New boxes | Why it is last |
|---|---|---|
| 0–1 | ingestion, quality gate, quant-core | the trusted core must be right before an LLM reads its output |
| **2** | `packages/agents` + `DeepDive*`/`AgentDecision` | needs a stable `ScreenRun` to deepen; prompts are byte-deterministic so the cache is real |
| 3 | `apps/web` chat + report | UI is a viewer over persisted runs — nothing to show until reports exist |
| 4 | backtest module | the screen is a *hypothesis*; it needs a history of verdicts (P2) before it can be scored |
| later | broker adapters | §4's Reader/Loader split makes this a re-fetch, not a rewrite |

---

## 4. Invariants to protect while it evolves

1. **R1 — store raw, adjust locally.** No provider's adjusted series enters
   signal math. (R3: never splice providers inside one series. R3a: "raw" is
   not comparable across providers outside a CA-free window.)
2. **Displayed price = raw.** Signals read the derived adjusted series; the
   user types orders against raw.
3. **Typed, loud data outcomes.** `FETCH_FAILED` must never read as
   "no opportunity"; degraded runs say so up front.
4. **Agents never hold authoritative state.** Structured verdicts only;
   `abstain ≠ neutral`.
5. **Decision log = cache + audit + debug.** One artifact, keyed by hash;
   byte-deterministic prompt builders are a tested invariant.
6. **Weekly sentinel is not optional** — the single-provider posture's only
   defense against silent history rewrites (HK lane; US relies on the
   same-provider leg).
