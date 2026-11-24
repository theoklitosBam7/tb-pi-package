import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { LeftGutter } from "./left-gutter.js";

const border = (text: string): string => `\u001b[31m${text}\u001b[0m`;

function lineSource(widths: number[], linesForWidth: (width: number) => string[]): Component {
  return {
    render(width) {
      widths.push(width);
      return linesForWidth(width);
    },
    invalidate() {},
  };
}

describe("LeftGutter", () => {
  it("does not expose the child's cached lines", () => {
    const lines = ["short"];
    const widths: number[] = [];
    const gutter = new LeftGutter(
      lineSource(widths, () => lines),
      border,
    );

    const rendered = gutter.render(1);

    expect(widths).toEqual([1]);
    expect(rendered).toEqual(lines);
    rendered.push("extra");
    expect(lines).toEqual(["short"]);
  });

  it("clamps the content width at width two", () => {
    const widths: number[] = [];
    const gutter = new LeftGutter(
      lineSource(widths, (width) => ["x".repeat(width)]),
      border,
    );

    const rendered = gutter.render(2);

    expect(widths).toEqual([1]);
    expect(rendered[0]).toBe(`${border("▌")}x`);
    expect(visibleWidth(rendered[0])).toBe(2);
  });

  it("reserves a space after the border at width four", () => {
    const widths: number[] = [];
    const gutter = new LeftGutter(
      lineSource(widths, (width) => ["x".repeat(width)]),
      border,
    );

    const rendered = gutter.render(4);

    expect(widths).toEqual([2]);
    expect(rendered[0]).toBe(`${border("▌")} xx`);
    expect(visibleWidth(rendered[0])).toBe(4);
  });
});
