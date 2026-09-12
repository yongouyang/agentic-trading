/**
 * Trade-journal linkage — does acting on the picker help, or not (2026-09-11).
 *
 * Every other instrument in this project measures a *signal*. This one measures
 * the **decision**: whether the trades actually made were the names the system
 * suggested, and how they did against the list they came from. Nothing else can
 * answer that, because nothing else sees the trades.
 *
 * Deliberately built BEFORE any trade history exists, so the analysis is written
 * and tested while it cannot be fitted to a result. The input is a **normalized
 * CSV** rather than a broker export: guessing a broker's headers from memory would
 * produce a parser that needs rewriting on first contact, whereas a schema we
 * control is stable and the broker-specific part reduces to one documented rename
 * plus the symbol codes (which *are* stable knowledge, and are implemented below).
 *
 * The linkage for one trade, in the order it is computed:
 *   1. `onList`  — was this symbol on the screen list for this market within
 *                  `lookbackSessions` before the trade?
 *   2. `listRank` / `conviction` — where, and what did the LLM think of it (null
 *                  when it was never deep-dived).
 *   3. `realizedReturn` — CLOSE-TO-CLOSE from the adjusted series, entry session
 *                  to exit. FIFO matching is quantity-aware: a sell consumes
 *                  open lots up to its quantity, each partial exit folds back
 *                  into its buy row quantity-weighted, and whatever remains is
 *                  marked to market at the latest bar while the row stays open.
 *   4. `listReturn` — the SAME quantity weights over the SAME windows applied
 *                  to the list's own top-N, which is the counterfactual: not
 *                  "did the trade make money" but "did it beat the list it was
 *                  chosen from".
 *
 * Returns basis is deliberately close-to-close only: the CSV's `price`/`fee`
 * are parsed and recorded but NEVER used for returns. `delta` must stay a pure
 * SELECTION measure comparable to `listReturn` (also close-to-close); execution
 * prices and fees would conflate selection with execution quality, which is a
 * different question.
 *
 * Rows are DECISIONS, not executions: one row per buy trade (partial exits fold
 * into it), plus one visible all-null row per sell that exceeds every open lot
 * (the excess, or an entirely unmatched sell) — an excess sell is kept visible
 * rather than silently absorbed or invented into a position.
 */

/** One execution, normalized. `side` is the direction of the trade. */
export interface JournalTrade {
  date: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  fee: number;
}

/** A symbol's presence on a screen list for one session. */
export interface ListMembership {
  market: string;
  /** The session the list was built for (`ScreenRun.sessionDate`). */
  sessionDate: string;
  symbol: string;
  rank: number;
  /** The LLM verdict for that name on that list, when it was deep-dived. */
  conviction: number | null;
}

/** Adjusted closes for one symbol, ascending by date. */
export interface JournalSeries {
  symbol: string;
  dates: string[];
  closes: number[];
}

export interface LinkedTrade {
  trade: JournalTrade;
  /** The session the trade's date maps to (last session at or before it). */
  entry: string;
  /** The last partial-exit session; null when the position was never sold
   *  (an open row is marked to market instead). */
  exit: string | null;
  /** Still held at the end of the data — return is marked to market. */
  open: boolean;
  onList: boolean;
  listSession: string | null;
  listRank: number | null;
  conviction: number | null;
  realizedReturn: number | null;
  holdSessions: number | null;
  /** The list's top-N return over the same windows with the SAME quantity
   *  weights as `realizedReturn`, so `delta` never mixes bases. */
  listReturn: number | null;
  /** Quantity-weighted (realized − list) over the pieces that have BOTH sides:
   *  the value of the decision, not of the market. */
  delta: number | null;
}

export interface JournalSummary {
  /** One row per DECISION: buys plus orphan sells. A matched sell folds into the
   *  buy row it closes, so this is not an execution count. */
  trades: number;
  buys: number;
  matched: number;
  open: number;
  onList: number;
  coverage: number;
  meanReturnOnList: number | null;
  meanReturnOffList: number | null;
  meanDeltaVsList: number | null;
  /** Mean conviction at entry across on-list trades that were deep-dived. */
  meanConviction: number | null;
}

/**
 * Futu/Moomoo-style symbol codes → the store's convention.
 *
 * This is the one piece of broker knowledge worth implementing, because it is
 * stable and mechanical: Futu writes `US.AAPL` and `HK.02269`, the store writes
 * `AAPL` and `02269.HK`. Anything already in the store's form passes through
 * untouched, so the function is safe on a hand-written file. SH./SZ. codes pass
 * through unchanged too — the store covers US/HK only, so there is no honest
 * mapping (mapping them to .HK invented fake symbols); `parseTradesCsv` rejects
 * them with a visible reason instead.
 */
export function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase();
  const m = /^(US|HK|SH|SZ)\.(.+)$/.exec(s);
  if (!m) return s;
  const [, market, code] = m as unknown as [string, string, string];
  if (market === "US") return code;
  if (market === "HK") return `${code.padStart(5, "0")}.HK`; // zero-padded to 5 digits in the store
  return s;
}

export interface ParsedTrades {
  trades: JournalTrade[];
  /** Rows dropped, with the reason — never silently discarded. */
  skipped: { line: number; reason: string; raw: string }[];
}

/** Split one CSV line, honouring double quotes. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Parse the normalized trade CSV.
 *
 * Schema (header row required, order free, extra columns ignored):
 *
 *   date,symbol,side,quantity,price,fee
 *   2026-09-14,US.AAPL,buy,10,230.50,1.99
 *
 * `fee` may be empty (treated as 0). Rows that cannot be parsed are returned with
 * a reason rather than dropped, because a silently skipped trade would make
 * coverage look better than it is — the same failure mode as a silently excluded
 * verdict in the Phase-5 harness.
 */
export function parseTradesCsv(text: string): ParsedTrades {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const trades: JournalTrade[] = [];
  const skipped: ParsedTrades["skipped"] = [];
  if (lines.length === 0) return { trades, skipped };
  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const need = ["date", "symbol", "side", "quantity", "price"];
  const missing = need.filter((n) => col(n) < 0);
  if (missing.length) throw new Error(`trade CSV is missing column(s): ${missing.join(", ")}`);

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]!;
    const f = splitCsvLine(raw);
    const date = f[col("date")] ?? "";
    const symbolRaw = f[col("symbol")] ?? "";
    const sideRaw = (f[col("side")] ?? "").toLowerCase();
    const qty = Number(f[col("quantity")]);
    const px = Number(f[col("price")]);
    const feeRaw = col("fee") >= 0 ? f[col("fee")] : "";
    const fee = feeRaw === "" || feeRaw === undefined ? 0 : Number(feeRaw);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      skipped.push({ line: i + 1, reason: `date must be YYYY-MM-DD, got "${date}"`, raw });
      continue;
    }
    if (!symbolRaw) {
      skipped.push({ line: i + 1, reason: "empty symbol", raw });
      continue;
    }
    if (/^(SH|SZ)\./.test(symbolRaw.trim().toUpperCase())) {
      skipped.push({ line: i + 1, reason: "SH/SZ codes are not supported (store covers US/HK only)", raw });
      continue;
    }
    // Accept buy|b|sell|s (case-insensitive).
    const side = sideRaw === "buy" || sideRaw === "b" ? "buy" : sideRaw === "sell" || sideRaw === "s" ? "sell" : null;
    if (!side) {
      skipped.push({ line: i + 1, reason: `side must be buy|sell, got "${sideRaw}"`, raw });
      continue;
    }
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(px) || px <= 0) {
      skipped.push({ line: i + 1, reason: `quantity and price must be positive numbers, got "${qty}"/"${px}"`, raw });
      continue;
    }
    if (!Number.isFinite(fee) || fee < 0) {
      skipped.push({ line: i + 1, reason: `fee must be a non-negative number, got "${feeRaw}"`, raw });
      continue;
    }
    trades.push({ date, symbol: normalizeSymbol(symbolRaw), side, quantity: qty, price: px, fee });
  }
  return { trades, skipped };
}

/** Last session at or before `date`, or null. */
function sessionAtOrBefore(dates: string[], date: string): string | null {
  let found: string | null = null;
  for (const d of dates) {
    if (d <= date) found = d;
    else break;
  }
  return found;
}

/** Number of sessions strictly after `a` up to and including `b`. */
function sessionsBetween(dates: string[], a: string, b: string): number {
  let n = 0;
  for (const d of dates) if (d > a && d <= b) n++;
  return n;
}

/** Total return between two sessions, from the adjusted closes. */
function returnBetween(series: JournalSeries, from: string, to: string): number | null {
  const i = series.dates.indexOf(from);
  const j = series.dates.indexOf(to);
  if (i < 0 || j < 0 || j <= i) return null;
  const a = series.closes[i]!;
  const b = series.closes[j]!;
  return a === 0 ? null : b / a - 1;
}

export interface LinkOptions {
  /** How many sessions back a list still counts as "the list you were looking at". */
  lookbackSessions?: number;
  /** The list's top-N used for the counterfactual (the displayed shortlist):
   *  one scalar for every market, or per market — a market with no entry falls
   *  back to 10. */
  topN?: number | Partial<Record<string, number>>;
}

/** The counterfactual top-N for one market (scalar, per-market, else 10). */
export function resolveTopN(topN: LinkOptions["topN"], market: string): number {
  if (typeof topN === "number") return topN;
  return topN?.[market] ?? 10;
}

/** One FIFO-consumed piece of a buy lot: quantity and both window returns
 *  (null when the window cannot be priced — dropped from BOTH sides). */
interface LotPiece {
  qty: number;
  rR: number | null;
  rL: number | null;
}

/** A buy lot's live matching state; its LinkedTrade row is `out[rowIdx]`. */
interface OpenLot {
  trade: JournalTrade;
  rowIdx: number;
  totalQty: number;
  remaining: number;
  pieces: LotPiece[];
  lastExit: string | null;
}

/**
 * Pair buys to sells quantity-aware FIFO per symbol, then attach the list
 * linkage and both returns. Rows stay one per DECISION: a sell consumes open
 * lots up to its quantity, each consumed piece accumulates into its buy row
 * quantity-weighted, and any remainder is marked to market while the row stays
 * open. Sell quantity beyond every open lot becomes a visible all-null row.
 */
export function linkTrades(
  trades: JournalTrade[],
  memberships: ListMembership[],
  seriesBySymbol: Map<string, JournalSeries>,
  opts: LinkOptions = {},
): LinkedTrade[] {
  const lookback = opts.lookbackSessions ?? 5;

  const ordered = [...trades].sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
  // Open lots per symbol, FIFO.
  const lots = new Map<string, OpenLot[]>();
  const allLots: OpenLot[] = [];
  const out: LinkedTrade[] = [];

  for (const t of ordered) {
    const series = seriesBySymbol.get(t.symbol);
    const entry = series ? sessionAtOrBefore(series.dates, t.date) : null;

    if (t.side === "buy") {
      const membership = pickMembership(memberships, t.symbol, entry, lookback, series?.dates ?? []);
      const lot: OpenLot = { trade: t, rowIdx: out.length, totalQty: t.quantity, remaining: t.quantity, pieces: [], lastExit: null };
      const queue = lots.get(t.symbol) ?? [];
      queue.push(lot);
      lots.set(t.symbol, queue);
      allLots.push(lot);
      out.push({
        trade: t,
        entry: entry ?? t.date,
        exit: null,
        open: true,
        onList: membership != null,
        listSession: membership?.sessionDate ?? null,
        listRank: membership?.rank ?? null,
        conviction: membership?.conviction ?? null,
        realizedReturn: null,
        holdSessions: null,
        listReturn: null,
        delta: null,
      });
      continue;
    }

    // A sell consumes open lots FIFO up to its quantity.
    const market = pickMembershipMarket(memberships, t.symbol);
    const topN = resolveTopN(opts.topN, market);
    const sellSession = series ? sessionAtOrBefore(series.dates, t.date) : null;
    let q = t.quantity;
    const queue = lots.get(t.symbol) ?? [];
    while (q > 0 && queue.length > 0) {
      const lot = queue[0]!;
      const take = Math.min(lot.remaining, q);
      lot.remaining -= take;
      q -= take;
      const from = out[lot.rowIdx]!.entry;
      const rR = series && sellSession ? returnBetween(series, from, sellSession) : null;
      const rL =
        series && sellSession ? listWindowReturn(memberships, seriesBySymbol, market, from, sellSession, topN) : null;
      lot.pieces.push({ qty: take, rR, rL });
      if (sellSession) lot.lastExit = sellSession;
      if (lot.remaining === 0) queue.shift();
    }
    if (q > 0) {
      // Quantity beyond every open lot: keep it visible rather than inventing
      // an entry — same philosophy as a wholly unmatched sell.
      out.push({
        trade: t,
        entry: t.date,
        exit: null,
        open: false,
        onList: false,
        listSession: null,
        listRank: null,
        conviction: null,
        realizedReturn: null,
        holdSessions: null,
        listReturn: null,
        delta: null,
      });
    }
  }

  // Finalize each buy row: the remaining quantity is one more piece, marked to
  // market, then every figure is quantity-weighted over the surviving pieces.
  for (const lot of allLots) {
    const row = out[lot.rowIdx]!;
    const series = seriesBySymbol.get(lot.trade.symbol);
    const lastSession = series?.dates[series.dates.length - 1] ?? null;
    const pieces = [...lot.pieces];
    if (lot.remaining > 0) {
      const market = pickMembershipMarket(memberships, lot.trade.symbol);
      const topN = resolveTopN(opts.topN, market);
      const rR = series && lastSession ? returnBetween(series, row.entry, lastSession) : null;
      const rL =
        series && lastSession ? listWindowReturn(memberships, seriesBySymbol, market, row.entry, lastSession, topN) : null;
      pieces.push({ qty: lot.remaining, rR, rL });
    }
    const weight = (ps: LotPiece[]) => ps.reduce((a, p) => a + p.qty, 0);
    // A piece whose own return is unpriceable drops out of BOTH sides and the
    // weights renormalize — the comparison must never mix bases.
    const scored = pieces.filter((p) => p.rR != null);
    const both = pieces.filter((p) => p.rR != null && p.rL != null);
    const realized = scored.length ? scored.reduce((a, p) => a + p.qty * p.rR!, 0) / weight(scored) : null;
    const listReturn = both.length ? both.reduce((a, p) => a + p.qty * p.rL!, 0) / weight(both) : null;
    const delta = both.length ? both.reduce((a, p) => a + p.qty * (p.rR! - p.rL!), 0) / weight(both) : null;
    const open = lot.remaining > 0;
    const to = open ? lastSession : lot.lastExit;
    row.exit = lot.lastExit;
    row.open = open;
    row.realizedReturn = realized;
    row.holdSessions = series && to ? sessionsBetween(series.dates, row.entry, to) : null;
    row.listReturn = listReturn;
    row.delta = delta;
  }
  return out;
}

/** A budget/report label for the market a symbol belongs to (HK codes end .HK). */
function pickMembershipMarket(memberships: ListMembership[], symbol: string): string {
  const hit = memberships.find((m) => m.symbol === symbol);
  if (hit) return hit.market;
  return symbol.endsWith(".HK") ? "HK" : "US";
}

/** The most recent list membership for a symbol within the lookback window. */
function pickMembership(
  memberships: ListMembership[],
  symbol: string,
  entry: string | null,
  lookback: number,
  tradingSessions: string[],
): ListMembership | null {
  if (!entry) return null;
  const candidates = memberships
    .filter((m) => m.symbol === symbol && m.sessionDate <= entry)
    .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  const last = candidates[candidates.length - 1];
  if (!last) return null;
  // "Within N sessions" must mean N *trading* sessions, counted from the entry's
  // own calendar. Counting distinct list publications instead made a small
  // lookback behave like no lookback at all, which is the bug this replaces.
  const elapsed = tradingSessions.filter((d) => d > last.sessionDate && d <= entry).length;
  return elapsed <= lookback ? last : null;
}

/** Equal-weight return of the list's top-N members from `from` to `to`. */
function listWindowReturn(
  memberships: ListMembership[],
  seriesBySymbol: Map<string, JournalSeries>,
  market: string,
  from: string,
  to: string,
  topN: number,
): number | null {
  // The list in force at `from`: the newest session at or before it.
  const sessions = memberships
    .filter((m) => m.market === market && m.sessionDate <= from)
    .map((m) => m.sessionDate)
    .sort();
  const session = sessions[sessions.length - 1];
  if (!session) return null;
  const top = memberships
    .filter((m) => m.market === market && m.sessionDate === session && m.rank <= topN)
    .map((m) => m.symbol);
  const rets: number[] = [];
  for (const sym of top) {
    const s = seriesBySymbol.get(sym);
    if (!s) continue;
    const r = returnBetween(s, from, to);
    if (r != null) rets.push(r);
  }
  return rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null;
}

export function summarizeJournal(linked: LinkedTrade[]): JournalSummary {
  const buys = linked.filter((l) => l.trade.side === "buy");
  const closedOrOpen = buys.filter((b) => b.realizedReturn != null);
  const onList = buys.filter((b) => b.onList);
  const offList = buys.filter((b) => !b.onList);
  const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const convs = onList.map((b) => b.conviction).filter((c): c is number => c != null);
  return {
    trades: linked.length,
    buys: buys.length,
    matched: buys.filter((b) => !b.open).length,
    open: buys.filter((b) => b.open).length,
    onList: onList.length,
    coverage: buys.length ? onList.length / buys.length : 0,
    meanReturnOnList: mean(onList.map((b) => b.realizedReturn).filter((r): r is number => r != null)),
    meanReturnOffList: mean(offList.map((b) => b.realizedReturn).filter((r): r is number => r != null)),
    meanDeltaVsList: mean(closedOrOpen.map((b) => b.delta).filter((d): d is number => d != null)),
    meanConviction: mean(convs),
  };
}
