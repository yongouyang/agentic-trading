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
 *   3. `realizedReturn` — from the entry session to the paired sell (FIFO), or
 *                  marked to market at the latest bar when still open.
 *   4. `listReturn` — what the list's own top-N would have returned over the SAME
 *                  window, which is the counterfactual: not "did the trade make
 *                  money" but "did it beat the list it was chosen from".
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
  exit: string | null;
  /** Still held at the end of the data — return is marked to market. */
  open: boolean;
  onList: boolean;
  listSession: string | null;
  listRank: number | null;
  conviction: number | null;
  realizedReturn: number | null;
  holdSessions: number | null;
  /** Equal-weight return of the list's top-N over the same entry→exit window. */
  listReturn: number | null;
  /** realizedReturn − listReturn: the value of the decision, not of the market. */
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
 * untouched, so the function is safe on a hand-written file.
 */
export function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase();
  const m = /^(US|HK|SH|SZ)\.(.+)$/.exec(s);
  if (!m) return s;
  const [, market, code] = m as unknown as [string, string, string];
  if (market === "US") return code;
  // HK codes are zero-padded to 5 digits in the store ("02269.HK").
  const padded = market === "HK" || market === "SH" || market === "SZ" ? code.padStart(5, "0") : code;
  return `${padded}.${market === "SH" || market === "SZ" ? "HK" : market}`;
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
    // Accept both the store's convention and the broker's ("buy"/"BUY"/"买").
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
  /** The list's top-N used for the counterfactual (the displayed shortlist). */
  topN?: number;
}

/**
 * Pair buys to sells FIFO per symbol, then attach the list linkage and both
 * returns. Unmatched buys are marked to market at the latest session.
 */
export function linkTrades(
  trades: JournalTrade[],
  memberships: ListMembership[],
  seriesBySymbol: Map<string, JournalSeries>,
  opts: LinkOptions = {},
): LinkedTrade[] {
  const lookback = opts.lookbackSessions ?? 5;
  const topN = opts.topN ?? 10;

  const ordered = [...trades].sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
  // Open lots per symbol, FIFO.
  const lots = new Map<string, JournalTrade[]>();
  const out: LinkedTrade[] = [];
  const lastSessionBySymbol = new Map<string, string | null>();

  for (const t of ordered) {
    const series = seriesBySymbol.get(t.symbol);
    const entry = series ? sessionAtOrBefore(series.dates, t.date) : null;
    if (series) lastSessionBySymbol.set(t.symbol, series.dates[series.dates.length - 1] ?? null);

    if (t.side === "buy") {
      const queue = lots.get(t.symbol) ?? [];
      queue.push(t);
      lots.set(t.symbol, queue);

      const membership = pickMembership(memberships, t.symbol, entry, lookback, series?.dates ?? []);
      const exit = series?.dates[series.dates.length - 1] ?? null;
      const realized = entry && exit && series ? returnBetween(series, entry, exit) : null;
      const listReturn =
        entry && exit && series
          ? listWindowReturn(memberships, seriesBySymbol, pickMembershipMarket(memberships, t.symbol), entry, exit, topN)
          : null;
      out.push({
        trade: t,
        entry: entry ?? t.date,
        exit,
        open: true,
        onList: membership != null,
        listSession: membership?.sessionDate ?? null,
        listRank: membership?.rank ?? null,
        conviction: membership?.conviction ?? null,
        realizedReturn: realized,
        holdSessions: entry && exit && series ? sessionsBetween(series.dates, entry, exit) : null,
        listReturn,
        delta: realized != null && listReturn != null ? realized - listReturn : null,
      });
      continue;
    }

    // A sell closes the oldest open lot for that symbol.
    const queue = lots.get(t.symbol) ?? [];
    const lot = queue.shift();
    lots.set(t.symbol, queue);
    if (!lot) {
      // A sell with no matching buy: keep it visible rather than inventing an entry.
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
      continue;
    }
    const lotIdx = out.findIndex((x) => x.trade === lot);
    const lotSeries = seriesBySymbol.get(t.symbol);
    const from = lotIdx >= 0 ? out[lotIdx]!.entry : null;
    const to = lotSeries ? sessionAtOrBefore(lotSeries.dates, t.date) : null;
    const realized = lotSeries && from && to ? returnBetween(lotSeries, from, to) : null;
    const listReturn =
      lotSeries && from && to
        ? listWindowReturn(memberships, seriesBySymbol, pickMembershipMarket(memberships, t.symbol), from, to, topN)
        : null;
    if (lotIdx >= 0) {
      const row = out[lotIdx]!;
      row.exit = to;
      row.open = false;
      row.realizedReturn = realized;
      row.holdSessions = lotSeries && from && to ? sessionsBetween(lotSeries.dates, from, to) : null;
      row.listReturn = listReturn;
      row.delta = realized != null && listReturn != null ? realized - listReturn : null;
    }
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
