import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConvictionBar } from "@/app/components/conviction-bar";

describe("ConvictionBar", () => {
  it("renders a positive fill right of center", () => {
    render(<ConvictionBar value={0.6} />);
    const fill = screen.getByTestId("conviction-fill");
    expect(fill).toHaveClass("conviction-fill--pos");
    expect(fill).toHaveStyle({ left: "50%", width: "30%" });
    expect(screen.getByTestId("conviction-bar")).toHaveTextContent("0.60");
  });

  it("renders a negative fill left of center", () => {
    render(<ConvictionBar value={-0.4} />);
    const fill = screen.getByTestId("conviction-fill");
    expect(fill).toHaveClass("conviction-fill--neg");
    expect(fill).toHaveStyle({ right: "50%", width: "20%" });
    expect(screen.getByTestId("conviction-bar")).toHaveTextContent("-0.40");
  });

  it("renders no fill at zero", () => {
    render(<ConvictionBar value={0} />);
    expect(screen.queryByTestId("conviction-fill")).not.toBeInTheDocument();
    expect(screen.getByTestId("conviction-bar")).toHaveTextContent("0.00");
  });

  it("clamps out-of-range values", () => {
    render(<ConvictionBar value={1.7} />);
    expect(screen.getByTestId("conviction-fill")).toHaveStyle({ width: "50%" });
    expect(screen.getByTestId("conviction-bar")).toHaveTextContent("1.00");
  });
});
