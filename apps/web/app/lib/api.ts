import type { DailyReport, DeepDiveReport, PriceHistory, RunSummary } from "../types";

/**
 * Server-side fetch helpers for the read API. Every helper never throws:
 * network/5xx → "unreachable", 404 → a typed empty state ("no-run" /
 * "not-found"). Follows the ApiHealth precedent (cache: "no-store",
 * API_INTERNAL_URL read at request time).
 */

export type FetchFailure = { kind: "unreachable" } | { kind: "no-run" } | { kind: "not-found" };
export type DailyResult = { kind: "ok"; report: DailyReport } | Exclude<FetchFailure, { kind: "not-found" }>;
export type DeepDiveResult = { kind: "ok"; report: DeepDiveReport } | Exclude<FetchFailure, { kind: "no-run" }>;
export type PriceHistoryResult = { kind: "ok"; history: PriceHistory } | Exclude<FetchFailure, { kind: "no-run" }>;
export type RunsResult = { kind: "ok"; runs: RunSummary[] } | { kind: "unreachable" };

async function get(path: string): Promise<Response | null> {
  const base = process.env.API_INTERNAL_URL;
  if (!base) return null;
  try {
    const res = await fetch(`${base}${path}`, { cache: "no-store" });
    return res;
  } catch {
    return null;
  }
}

export async function fetchDailyReport(market: "US" | "HK", runId?: number): Promise<DailyResult> {
  const res = await get(`/reports/daily?market=${market}${runId === undefined ? "" : `&runId=${runId}`}`);
  if (!res) return { kind: "unreachable" };
  if (res.status === 404) return { kind: "no-run" };
  if (!res.ok) return { kind: "unreachable" };
  return { kind: "ok", report: (await res.json()) as DailyReport };
}

/** Phase-3c: GET /reports/runs — never 404s; any failure → unreachable (the
 *  caller renders no picker, matching the lane's degraded posture). */
export async function fetchRuns(market?: "US" | "HK", symbol?: string): Promise<RunsResult> {
  const params = new URLSearchParams();
  if (market) params.set("market", market);
  if (symbol) params.set("symbol", symbol);
  const qs = params.toString();
  const res = await get(`/reports/runs${qs ? `?${qs}` : ""}`);
  if (!res || !res.ok) return { kind: "unreachable" };
  const data: unknown = await res.json();
  return { kind: "ok", runs: Array.isArray(data) ? (data as RunSummary[]) : [] };
}

export async function fetchDeepDive(runId: number, symbol: string): Promise<DeepDiveResult> {
  const res = await get(`/reports/deep-dive/${runId}/${encodeURIComponent(symbol)}`);
  if (!res) return { kind: "unreachable" };
  if (res.status === 404) return { kind: "not-found" };
  if (!res.ok) return { kind: "unreachable" };
  return { kind: "ok", report: (await res.json()) as DeepDiveReport };
}

export async function fetchPriceHistory(symbol: string, days = 250): Promise<PriceHistoryResult> {
  const res = await get(`/instruments/${encodeURIComponent(symbol)}/price-history?days=${days}`);
  if (!res) return { kind: "unreachable" };
  if (res.status === 404) return { kind: "not-found" };
  if (!res.ok) return { kind: "unreachable" };
  return { kind: "ok", history: (await res.json()) as PriceHistory };
}
