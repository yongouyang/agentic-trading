import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/app/components/markdown";

describe("Markdown", () => {
  it("renders paragraphs and joins consecutive lines", () => {
    render(<Markdown text={"first line\nsecond line\n\nanother paragraph"} />);
    const paras = screen.getAllByText(/first line|another paragraph/);
    expect(paras[0]).toHaveTextContent("first line second line");
    expect(paras[1]).toHaveTextContent("another paragraph");
  });

  it("renders headings as h3/h4/h5", () => {
    const { container } = render(<Markdown text={"# one\n## two\n### three"} />);
    expect(container.querySelector("h3")).toHaveTextContent("one");
    expect(container.querySelector("h4")).toHaveTextContent("two");
    expect(container.querySelector("h5")).toHaveTextContent("three");
  });

  it("renders bold, italic, inline code and links", () => {
    const { container } = render(
      <Markdown text={"a **bold** b *italic* c `code` d [label](https://example.com/x)"} />,
    );
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("em")).toHaveTextContent("italic");
    expect(container.querySelector("code")).toHaveTextContent("code");
    const link = screen.getByRole("link", { name: "label" });
    expect(link).toHaveAttribute("href", "https://example.com/x");
  });

  it("renders unordered and ordered lists", () => {
    const { container } = render(<Markdown text={"- a\n- b\n\n1. one\n2. two"} />);
    const ul = container.querySelector("ul");
    const ol = container.querySelector("ol");
    expect(ul).toHaveTextContent("a");
    expect(ul).toHaveTextContent("b");
    expect(ol).toHaveTextContent("one");
    expect(ol).toHaveTextContent("two");
  });

  it("renders fenced code blocks verbatim (no inline parsing inside)", () => {
    render(<Markdown text={"before\n```\nconst x = **not bold**;\n```\nafter"} />);
    const code = screen.getByTestId("md-code");
    expect(code).toHaveTextContent("const x = **not bold**;");
    expect(code.querySelector("strong")).toBeNull();
  });

  it("escapes raw html by construction", () => {
    const { container } = render(<Markdown text={"<img src=x onerror=alert(1)>"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("<img src=x onerror=alert(1)>");
  });
});
