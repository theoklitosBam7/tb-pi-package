import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { LeftGutter } from "./left-gutter.js";

function lineSource(lines: string[]): Component {
  return {
    render: () => lines,
    invalidate() {},
  };
}

describe("LeftGutter", () => {
  it("returns a new array when the child lines pass through unchanged", () => {
    const lines = ["short"];
    const gutter = new LeftGutter(lineSource(lines), (text) => `[${text}]`);

    const rendered = gutter.render(1);

    expect(rendered).toEqual(lines);
    expect(rendered).not.toBe(lines);
  });

  it("prefixes child lines at width two", () => {
    const gutter = new LeftGutter(lineSource(["line"]), (text) => `*${text}*`);

    expect(gutter.render(2)).toEqual(["*▌*line"]);
  });
});
