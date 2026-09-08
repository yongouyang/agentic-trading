import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RatingBadge } from "@/app/components/rating-badge";
import type { Rating } from "@/app/types";

describe("RatingBadge", () => {
  it.each<[Rating, string]>([
    ["strong_sell", "strong sell"],
    ["sell", "sell"],
    ["hold", "hold"],
    ["buy", "buy"],
    ["strong_buy", "strong buy"],
  ])("renders the %s tier with its own class", (rating, label) => {
    render(<RatingBadge rating={rating} />);
    const badge = screen.getByTestId("rating-badge");
    expect(badge).toHaveTextContent(label);
    expect(badge).toHaveClass("badge", `badge--${rating}`);
  });

  it("renders an em-dash for a null rating", () => {
    render(<RatingBadge rating={null} />);
    const badge = screen.getByTestId("rating-badge");
    expect(badge).toHaveTextContent("—");
    expect(badge).toHaveClass("badge--none");
  });
});
