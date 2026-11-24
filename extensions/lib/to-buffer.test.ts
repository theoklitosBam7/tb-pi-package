import { describe, expect, it } from "vitest";
import { toBuffer } from "./to-buffer.js";

describe("toBuffer", () => {
  it("passes through a Buffer chunk", () => {
    const chunk = Buffer.from([1, 2, 3]);

    expect(toBuffer(chunk)).toBe(chunk);
  });

  it("copies the bytes of a plain Uint8Array without sharing storage", () => {
    const input = Uint8Array.of(0x00, 0xff, 0x80).subarray(1);
    const bytes = toBuffer(input);

    expect([...bytes]).toEqual([0xff, 0x80]);
    bytes[0] = 0;
    expect(input[0]).toBe(0xff);
  });

  it("converts a string chunk to UTF-8 bytes", () => {
    expect([...toBuffer("é")]).toEqual([0xc3, 0xa9]);
  });
});
