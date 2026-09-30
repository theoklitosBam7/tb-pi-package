import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { recordLiveSession, transcribePcm } from "./live.js";

describe("Foundry live transcription", () => {
  it("publishes partial text before recording ends and replaces it with the final transcript", async () => {
    const updates: string[] = [];
    const session = {
      start: async () => {},
      append: async () => {},
      stop: async () => {},
      async *getStream() {
        yield { content: [{ text: "Hello" }], is_final: false };
        yield { content: [{ text: " wor" }], is_final: false };
        yield { content: [{ text: "Hello world." }], is_final: true };
      },
    };
    async function* pcm() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(updates).toEqual(["Hello", "Hello wor", "Hello world."]);
      yield new Uint8Array([0, 0]);
    }
    expect(await transcribePcm(session, pcm(), (text) => updates.push(text))).toBe("Hello world.");
  });
  it.skipIf(
    process.platform !== "darwin" ||
      spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0,
  )("keeps the transcript after Enter stops FFmpeg with exit code 255", async () => {
    const recorder = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-re",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=16000:cl=mono",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const session = {
      start: vi.fn().mockResolvedValue(undefined),
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      async *getStream() {
        yield { content: [{ text: "Hello" }], is_final: true };
      },
    };
    const ui = {
      onTerminalInput: (listener: (data: string) => unknown) => {
        const timer = setTimeout(() => listener("\r"), 350);
        return () => clearTimeout(timer);
      },
    };
    expect(await recordLiveSession(session, recorder, ui)).toBe("Hello");
    expect(session.append).toHaveBeenCalled();
    expect(recorder.exitCode).toBe(255);
  });

  it("streams 16-bit PCM and returns final transcript segments, not partial repeats", async () => {
    const pcm = [new Uint8Array([1, 0, 2, 0]), new Uint8Array([3, 0, 4, 0])];
    const append = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const session = {
      start: vi.fn().mockResolvedValue(undefined),
      append,
      stop,
      async *getStream() {
        yield { content: [{ text: "Hell" }], is_final: false };
        yield { content: [{ text: "Hello" }], is_final: true };
        yield { content: [{ text: " world" }], is_final: true };
      },
    };
    async function* source() {
      for (const chunk of pcm) yield chunk;
    }
    const result = await transcribePcm(session, source());
    expect(result).toBe("Hello world");
    expect(append.mock.calls.map(([chunk]) => [...chunk])).toEqual([
      [1, 0, 2, 0],
      [3, 0, 4, 0],
    ]);
    expect(stop).toHaveBeenCalledOnce();
  });
});
