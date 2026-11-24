import { describe, expect, it } from "vitest";
import { copyRenderLines } from "./mutable-lines.js";

describe("copyRenderLines", () => {
  it("copies cached lines before mutation", () => {
    const lines = Object.freeze(["line"]);
    const copy = copyRenderLines(lines);

    expect(copy).toEqual(lines);

    copy.push("extra");

    expect(lines).toEqual(["line"]);
  });
});
