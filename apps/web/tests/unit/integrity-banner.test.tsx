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
});
