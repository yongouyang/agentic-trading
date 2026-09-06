/**
 * Unit tests for mergeF10ForSymbol (src/cli/refresh-f10-ca.ts) — the per-name
 * merge of stored CA rows with fresh F10 rows is pure, so the whole decision
 * table is tested with plain objects: in-specie upsert shape, degraded
 * overlay (corrects USD-declaring amounts, leaves HKD-native alone), ex-date
 * mismatches warn without writing, bonus/unknown warn, newly-degraded
 * detection. No db, no network.
 */
import { describe, expect, it } from "vitest";
import type { F10DividendRow } from "../../src/market-data/eastmoney-f10.provider.js";
import { mergeF10ForSymbol, type StoredCaRow } from "../../src/cli/refresh-f10-ca.js";

const row = (exDate: string | null, plan: string, reportType = "年度分配"): F10DividendRow => ({
  noticeDate: null,
  exDate,
  payDate: null,
  reportType,
  plan,
});

const div = (date: string, amount: number, currency = "HKD"): StoredCaRow => ({ date, type: "DIVIDEND", amount, currency });

describe("mergeF10ForSymbol — IN_SPECIE import (all stocks, degraded or not)", () => {
  it("in-specie with HKD equivalent upserts amount + HKD + detail with parsed ratio", () => {
    const r = mergeF10ForSymbol([], [row("2023-01-05", "特殊说明:每10股分派1股美团B类普通股股份(相当于每股派18.13港元)", "特别分配")], false);
    expect(r.writes).toEqual([
      {
        date: "2023-01-05",
        type: "IN_SPECIE",
        amount: 18.13,
        currency: "HKD",
        detail: "特殊说明:每10股分派1股美团B类普通股股份(相当于每股派18.13港元) [parsed ratio 1/10 — 美团B类普通股股份]",
      },
    ]);
    expect(r.warnings).toEqual([]);
    expect(r.newlyDegraded).toBe(false);
  });

  it("ratio-only in-specie upserts amount null + empty currency", () => {
    const r = mergeF10ForSymbol([], [row("2022-01-20", "特殊说明:每21股腾讯股份分派1股京东集团A类普通股股份", "特别分配")], false);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatchObject({ date: "2022-01-20", type: "IN_SPECIE", amount: null, currency: "" });
  });

  it("in-specie row without ex-date warns and writes nothing", () => {
    const r = mergeF10ForSymbol([], [row(null, "特殊说明:每10股分派1股美团B类普通股股份", "特别分配")], false);
    expect(r.writes).toEqual([]);
    expect(r.warnings.join(" ")).toContain("without ex-date");
  });
});

describe("mergeF10ForSymbol — degraded overlay (CA_DEGRADED names)", () => {
  it("overwrites a Yahoo FX-converted amount with the F10 HKD equivalent", () => {
    const stored = [div("2026-08-13", 0.78407)];
    const f10 = [row("2026-08-13", "每股派美元0.1元(相当于港币0.784234元(计算值))")];
    const r = mergeF10ForSymbol(stored, f10, true);
    expect(r.writes).toEqual([
      { date: "2026-08-13", type: "DIVIDEND", amount: 0.784234, currency: "HKD", detail: "每股派美元0.1元(相当于港币0.784234元(计算值))" },
    ]);
    expect(r.warnings.join(" ")).toContain("overlay:");
    expect(r.newlyDegraded).toBe(false);
  });

  it("leaves an already-correct amount untouched (no write, no overlay warning)", () => {
    const stored = [div("2026-08-13", 0.784234)];
    const f10 = [row("2026-08-13", "每股派美元0.1元(相当于港币0.784234元(计算值))")];
    const r = mergeF10ForSymbol(stored, f10, true);
    expect(r.writes).toEqual([]);
    expect(r.warnings.join(" ")).not.toContain("overlay:");
  });

  it("F10 ex-date with no stored DIVIDEND row warns, no write (and vice versa)", () => {
    const stored = [div("2025-08-13", 0.75)];
    const f10 = [row("2026-08-13", "每股派美元0.1元(相当于港币0.784234元(计算值))")];
    const r = mergeF10ForSymbol(stored, f10, true);
    expect(r.writes).toEqual([]);
    expect(r.warnings.join(" ")).toContain("has no stored DIVIDEND row");
    expect(r.warnings.join(" ")).toContain("no F10 cash row");
  });

  it("non-HKD cash on an unflagged name ⇒ newlyDegraded + overlay applies this run", () => {
    const stored = [div("2026-08-13", 0.78407)];
    const f10 = [row("2026-08-13", "每股派美元0.1元(相当于港币0.784234元(计算值))")];
    const r = mergeF10ForSymbol(stored, f10, false);
    expect(r.newlyDegraded).toBe(true);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]).toMatchObject({ type: "DIVIDEND", amount: 0.784234 });
  });
});

describe("mergeF10ForSymbol — non-degraded cross-check (warn-only)", () => {
  it("HKD-native amounts agreeing within 0.5% ⇒ silent ok", () => {
    const stored = [div("2026-05-15", 5.3)];
    const f10 = [row("2026-05-15", "每股派港币5.3元")];
    const r = mergeF10ForSymbol(stored, f10, false);
    expect(r.writes).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("HKD amount deviating > 0.5% ⇒ warning, no write", () => {
    const stored = [div("2026-05-15", 5.0)];
    const f10 = [row("2026-05-15", "每股派港币5.3元")];
    const r = mergeF10ForSymbol(stored, f10, false);
    expect(r.writes).toEqual([]);
    expect(r.warnings.join(" ")).toContain("cross-check:");
    expect(r.warnings.join(" ")).toContain("no write");
  });
});

describe("mergeF10ForSymbol — out-of-scope plan kinds are loud", () => {
  it("bonus plan ⇒ warning naming the split-class scope decision", () => {
    const r = mergeF10ForSymbol([], [row("2025-06-10", "每10股派送8股,每10股转12股")], false);
    expect(r.writes).toEqual([]);
    expect(r.warnings.join(" ")).toContain("split-class, out of scope");
  });

  it("unparsed plan ⇒ kind=unknown warning", () => {
    const r = mergeF10ForSymbol([], [row("2020-01-01", "不派息")], false);
    expect(r.writes).toEqual([]);
    expect(r.warnings.join(" ")).toContain("kind=unknown");
  });
});

describe("mergeF10ForSymbol — share-terms guard across bonus events (1211.HK, measured live 2026-09-06)", () => {
  // BYD 2025-06-10: the bonus clause is EMBEDDED in the cash row's plan
  // (`每股派人民币3.974元(相当于港币4.33596元),每10股派送8股,每10股转12股`).
  // F10 cash amounts at/before it are as-declared in PRE-split share terms
  // (4.33596 = 3 × stored 1.44532); stored Yahoo amounts are split-adjusted.
  // Overlay across that boundary would corrupt the store by the split factor.
  const embeddedBonusCash = row("2025-06-10", "每股派人民币3.974元(相当于港币4.33596元),每10股派送8股,每10股转12股");
  const preBonusAsDeclared = row("2024-06-11", "每股派人民币3.098元(相当于港币3.40609元)");
  const postBonusCash = row("2026-06-11", "每股派人民币0.358元(相当于港币0.41141元)");

  it("degraded name with an embedded bonus: ex-dates ≤ bonus are NOT overlaid (warned), later ones are", () => {
    const stored = [div("2024-06-11", 1.135363), div("2025-06-10", 1.44532), div("2026-06-11", 0.41)];
    const r = mergeF10ForSymbol(stored, [embeddedBonusCash, preBonusAsDeclared, postBonusCash], true);
    expect(r.writes).toEqual([
      { date: "2026-06-11", type: "DIVIDEND", amount: 0.41141, currency: "HKD", detail: "每股派人民币0.358元(相当于港币0.41141元)" },
    ]);
    expect(r.warnings.join(" ")).toContain("pre-split share terms");
    expect(r.warnings.join(" ")).toContain("2025-06-10");
  });

  it("standalone bonus row (no cash in it) also sets the guard", () => {
    const bonus = row("2025-06-10", "每10股派送8股,每10股转12股");
    const preBonusCash = row("2024-06-11", "每股派人民币3.098元(相当于港币3.40609元)");
    const stored = [div("2024-06-11", 1.135363)];
    const r = mergeF10ForSymbol(stored, [bonus, preBonusCash], true);
    expect(r.writes).toEqual([]);
    expect(r.warnings.join(" ")).toContain("pre-split share terms");
  });

  it("non-degraded name with a bonus: pre-bonus ex-dates are NOT cross-checked either", () => {
    // Without the guard this fixture would warn ~200% dev on 2024-06-11.
    const stored = [div("2024-06-11", 1.135363)];
    const r = mergeF10ForSymbol(stored, [embeddedBonusCash, preBonusAsDeclared], false);
    expect(r.writes).toEqual([]);
    expect(r.warnings.join(" ")).not.toContain("cross-check:");
    expect(r.warnings.join(" ")).toContain("pre-split share terms");
  });
});

describe("mergeF10ForSymbol — same-ex-date cash rows sum (0005.HK 2024-05-09, measured)", () => {
  // HSBC went ex ordinary USD 0.10 + special USD 0.21 on the SAME date; F10
  // carries two rows, Yahoo's event stream records only 0.780688 (the 0.10).
  // The ex-date price drop reflects the SUM, so the overlay writes the sum.
  const ordinary = row("2024-05-09", "每股派美元0.1元(相当于港币0.780688元)", "一季度分配");
  const special = row("2024-05-09", "每股派美元0.21元(相当于港币1.639445元)", "特别分配");

  it("overlay writes 0.780688 + 1.639445 = 2.420133 with both plans in detail", () => {
    const r = mergeF10ForSymbol([div("2024-05-09", 0.780688)], [ordinary, special], true);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]!.amount).toBeCloseTo(2.420133, 6);
    expect(r.writes[0]!.detail).toContain("0.1元");
    expect(r.writes[0]!.detail).toContain("0.21元");
  });
});
