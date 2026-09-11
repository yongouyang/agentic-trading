import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntegrityBanner } from "@/app/components/integrity-banner";
import type { IntegrityHeader } from "@/app/types";

const okIntegrity: IntegrityHeader = {
  universeSize: 10,
  ok: 9,
  genuinelyAbsent: 1,
  fetchFailed: 0,
  degraded: false,
  warnings: [],
};

const degradedIntegrity: IntegrityHeader = {
  universeSize: 10,
  ok: 7,
  genuinelyAbsent: 1,
  fetchFailed: 2,
  degraded: true,
  warnings: ["bars fetch failed for 0001.HK", "CA derivation degraded"],
};

describe("IntegrityBanner", () => {
  it("renders screened/excluded counts without a banner when ok", () => {
    render(<IntegrityBanner integrity={okIntegrity} />);
    expect(screen.getByTestId("integrity-banner")).toHaveTextContent(
      "screened 10 · ok 9 · excluded 1",
    );
    expect(screen.queryByTestId("degraded-banner")).not.toBeInTheDocument();
  });

  it("renders a red degraded banner listing warnings", () => {
    render(<IntegrityBanner integrity={degradedIntegrity} />);
    const banner = screen.getByTestId("degraded-banner");
    expect(banner).toHaveClass("banner-degraded");
    expect(banner).toHaveTextContent(/degraded run/);
    expect(banner).toHaveTextContent("bars fetch failed for 0001.HK");
    expect(banner).toHaveTextContent("CA derivation degraded");
    expect(screen.getByTestId("integrity-banner")).toHaveTextContent(
      "excluded 3 (fetch failed 2)",
    );
  });

  it("renders the degraded banner even with no warnings", () => {
    render(<IntegrityBanner integrity={{ ...degradedIntegrity, warnings: [] }} />);
    const banner = screen.getByTestId("degraded-banner");
    expect(banner).toHaveTextContent(/degraded run/);
    expect(banner.querySelector("ul")).toBeNull();
  });

  // W3b: the effective data cutoff, so a shortlist ranked from stale data is
  // visible rather than implied.
  it("renders 'data through <date>' when the api supplies a cutoff", () => {
    render(<IntegrityBanner integrity={{ ...okIntegrity, dataThrough: "2026-09-08" }} />);
    expect(screen.getByTestId("integrity-banner")).toHaveTextContent("data through 2026-09-08");
  });

  it("an absent cutoff renders exactly as before (additive field)", () => {
    render(<IntegrityBanner integrity={okIntegrity} />);
    expect(screen.getByTestId("integrity-banner")).toHaveTextContent(
      "screened 10 · ok 9 · excluded 1",
    );
    expect(screen.getByTestId("integrity-banner")).not.toHaveTextContent(/data through/);
  });

  // Phase 4b item 6: the header vouches for the DATA; this line is the only place
  // that says the RULES behind the ranking are unvalidated. Without it the list
  // reads as more authoritative than the evidence supports.
  it("renders the rule-provenance caveat when the api supplies one", () => {
    const caveat = "ranking rules are an unvalidated hypothesis — see docs/phase-4b-plan.md";
    render(<IntegrityBanner integrity={{ ...okIntegrity, caveat }} />);
    const el = screen.getByTestId("integrity-caveat");
    expect(el).toHaveTextContent(caveat);
    expect(el).toHaveClass("integrity-caveat");
  });

  it("an absent caveat renders exactly as before (additive field)", () => {
    render(<IntegrityBanner integrity={okIntegrity} />);
    expect(screen.queryByTestId("integrity-caveat")).not.toBeInTheDocument();
  });
});
