import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Page from "@/app/page";

// Page nests the async server component ApiHealth — stub it (its own tests
// live in api-health.test.tsx).
vi.mock("@/app/api-health", () => ({
  ApiHealth: () => <p data-testid="api-health">api: stubbed</p>,
}));

describe("placeholder page", () => {
  it("renders the scaffold heading and placeholder copy", () => {
    render(<Page />);
    expect(screen.getByRole("heading", { name: "agentic-trading" })).toBeInTheDocument();
    expect(screen.getByText(/Phase 0 scaffold/)).toBeInTheDocument();
    expect(screen.getByTestId("api-health")).toHaveTextContent("api: stubbed");
  });
});
