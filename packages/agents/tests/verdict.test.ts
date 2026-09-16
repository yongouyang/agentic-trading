/**
 * Verdict parser: valid (bare + fenced), schema violations, JSON extraction
 * from prose, and the repair-message contract. No network.
 */
import { describe, expect, it } from "vitest";
import { buildRepairMessage, extractJsonCandidate, parseVerdict } from "../src/verdict.js";

const VALID = {
  rating: "buy",
  conviction: 0.65,
  abstain: false,
  thesis: "Improving fundamentals and constructive news flow.",
  keyRisks: ["regulatory"],
  invalidationConditions: ["revenue growth turns negative"],
};

describe("parseVerdict — valid", () => {
  it("parses a bare JSON object", () => {
    const r = parseVerdict(JSON.stringify(VALID));
    expect(r).toEqual({ ok: true, verdict: VALID });
  });

  it("parses a fenced object inside prose", () => {
    const r = parseVerdict(`Here is my verdict:\n\`\`\`json\n${JSON.stringify(VALID, null, 2)}\n\`\`\`\nDone.`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.rating).toBe("buy");
  });
});

describe("parseVerdict — schema violations", () => {
  const cases: [string, unknown, string][] = [
    ["bad rating", { ...VALID, rating: "strong_buy_maybe" }, "rating must be one of"],
    ["conviction out of range", { ...VALID, conviction: 1.5 }, "conviction must be a number in [-1,1]"],
    ["conviction not a number", { ...VALID, conviction: "high" }, "conviction"],
    ["abstain not boolean", { ...VALID, abstain: "no" }, "abstain must be boolean"],
    ["empty thesis", { ...VALID, thesis: "  " }, "thesis must be a non-empty string"],
    ["keyRisks not an array", { ...VALID, keyRisks: "risk" }, "keyRisks must be a string array"],
    ["keyRisks with non-strings", { ...VALID, keyRisks: [1] }, "keyRisks must be a string array"],
    ["missing invalidationConditions", { rating: "buy", conviction: 0.5, abstain: false, thesis: "t", keyRisks: [] }, "invalidationConditions"],
  ];
  for (const [name, payload, errFragment] of cases) {
    it(`rejects ${name}`, () => {
      const r = parseVerdict(JSON.stringify(payload));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(errFragment);
    });
  }

  it("rejects text without any JSON object", () => {
    const r = parseVerdict("I think this stock is great, no JSON for you.");
    expect(r).toEqual({ ok: false, error: "no JSON object found in response" });
  });

  it("rejects malformed JSON", () => {
    const r = parseVerdict('{"rating": "buy", oops}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("JSON.parse failed");
  });

  // Regression: the verbatim shape deepseek-flash produced on 2026-09-16
  // (one real response, complete object, thesis wrapped across raw lines).
  it("accepts raw newlines inside string values", () => {
    const r = parseVerdict(
      `{
  "rating": "buy",
  "conviction": 0.25,
  "abstain": false,
  "thesis": "The bull edges this debate: 1H26 revenue inflected to +3.9% y/y after FY25's decline.
Credit quality is described as stable and the 44% net margin is a genuine franchise.
This is a mild, not a high-conviction, positive stance.",
  "keyRisks": ["NIM compression"],
  "invalidationConditions": ["price closes under the 200-day SMA"]
}`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict.thesis).toContain("mild");
      expect(r.verdict.rating).toBe("buy");
    }
  });

  it("accepts unescaped quotes inside string values", () => {
    // Verbatim from the same 2026-09-16 response: the model quoted a phrase
    // without escaping it, which ends the string early for JSON.parse.
    const r = parseVerdict(
      `{"rating": "buy", "conviction": 0.25, "abstain": false,
        "thesis": "The bull edges this debate: the "one half is not a trend" objection cuts both ways.",
        "keyRisks": ["NIM compression"],
        "invalidationConditions": ["price closes under the 200-day SMA"]}`,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.thesis).toContain('"one half is not a trend"');
  });

  it("still fails a truncated response (no closing brace) instead of half-parsing it", () => {
    const r = parseVerdict('{\n  "rating": "neutral",\n  "thesis": "This is a genuinely\n');
    expect(r).toEqual({ ok: false, error: "no JSON object found in response" });
  });

  it("conviction bounds are inclusive", () => {
    for (const c of [-1, 1]) {
      const r = parseVerdict(JSON.stringify({ ...VALID, conviction: c }));
      expect(r.ok).toBe(true);
    }
  });
});

describe("extractJsonCandidate", () => {
  it("handles braces inside strings", () => {
    const text = '{"thesis": "use {curly} braces", "rating": "buy"} trailing';
    expect(extractJsonCandidate(text)).toBe('{"thesis": "use {curly} braces", "rating": "buy"}');
  });
});

describe("buildRepairMessage", () => {
  it("carries schema, validation error, and the offending response", () => {
    const msg = buildRepairMessage("garbage output", "rating must be one of ...");
    expect(msg).toContain("Return ONLY a JSON object");
    expect(msg).toContain('"rating"');
    expect(msg).toContain("Validation error: rating must be one of ...");
    expect(msg).toContain("garbage output");
  });
});
