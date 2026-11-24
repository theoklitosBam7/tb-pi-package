import { describe, expect, it } from "vitest";
import { mutableLines } from "./mutable-lines.js";

describe("mutableLines", () => {
  it("copies cached lines before mutation", () => {
    const lines = Object.freeze(["line"]);
    const copy = mutableLines(lines);

    expect(copy).toEqual(lines);

    copy.push("extra");

    expect(lines).toEqual(["line"]);
  });
});
