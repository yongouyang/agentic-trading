"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { RunSummary } from "../types";

/**
 * Historical-run picker (phase-3c): a dropdown of RunSummary rows, newest
 * first. Selection rewrites the `param` query param via client navigation so
 * the URL stays shareable; the empty "latest run" option removes the param
 * (absent = latest, the pre-3c behavior). Other params (the sibling lane's on
 * the dashboard) are preserved. Renders nothing when there are no runs — the
 * picker degrades with its lane, never a 500.
 */
export function RunPicker({
  runs,
  param,
  current,
  testId,
}: {
  runs: RunSummary[];
  /** Query param to rewrite: "hkRun" / "usRun" on the dashboard, "run" on the symbol page. */
  param: string;
  /** Currently selected run id; undefined = latest (param absent). */
  current?: number;
  testId?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (runs.length === 0) return null;

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const params = new URLSearchParams(searchParams.toString());
    if (e.target.value === "") params.delete(param);
    else params.set(param, e.target.value);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <select
      className="run-picker"
      data-testid={testId ?? "run-picker"}
      aria-label="run picker"
      value={current ?? ""}
      onChange={onChange}
    >
      <option value="">latest run</option>
      {runs.map((r) => (
        <option key={r.id} value={r.id}>
          {`run ${r.id} · ${new Date(r.runAt).toLocaleString("en-GB", { hour12: false })} · topN ${r.topN}` +
            // An operator run is labelled, because it is reachable here on purpose
            // but is not what the lane shows by default.
            (r.source === "adhoc" ? " · ad-hoc" : "")}
        </option>
      ))}
    </select>
  );
}
