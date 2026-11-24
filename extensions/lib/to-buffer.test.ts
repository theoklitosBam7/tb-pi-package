import { describe, expect, it } from "vitest";
import { toBuffer } from "./to-buffer.js";

describe("toBuffer", () => {
  it("passes through a Buffer chunk", () => {
    const chunk = Buffer.from([1, 2, 3]);

    expect(toBuffer(chunk)).toBe(chunk);
  });

  it("converts a string chunk to UTF-8 bytes", () => {
    expect([...toBuffer("é")]).toEqual([0xc3, 0xa9]);
  });
});
