import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { LeftGutter } from "./left-gutter.js";

const border = (text: string): string => `\u001b[31m${text}\u001b[0m`;

function cachedLineSource(lines: string[], widths: number[]): Component {
  return {
    render(width) {
      widths.push(width);
      return lines;
    },
    invalidate() {},
  };
}

function sizedLineSource(widths: number[]): Component {
  return {
    render(width) {
      widths.push(width);
      return ["x".repeat(width)];
    },
    invalidate() {},
  };
}

describe("LeftGutter", () => {
  it("returns a new array when the child lines pass through unchanged", () => {
    const lines = ["short"];
    const widths: number[] = [];
    const gutter = new LeftGutter(cachedLineSource(lines, widths), border);

    const rendered = gutter.render(1);

    expect(widths).toEqual([1]);
    expect(rendered).toEqual(lines);
    expect(rendered).not.toBe(lines);
  });

  it("clamps the content width at width two", () => {
    const widths: number[] = [];
    const gutter = new LeftGutter(sizedLineSource(widths), border);

    const rendered = gutter.render(2);

    expect(widths).toEqual([1]);
    expect(rendered[0]).toBe(`${border("▌")}x`);
    expect(visibleWidth(rendered[0])).toBe(2);
  });

  it("reserves a space after the border at width four", () => {
    const widths: number[] = [];
    const gutter = new LeftGutter(sizedLineSource(widths), border);

    const rendered = gutter.render(4);

    expect(widths).toEqual([2]);
    expect(rendered[0]).toBe(`${border("▌")} xx`);
    expect(visibleWidth(rendered[0])).toBe(4);
  });
});
