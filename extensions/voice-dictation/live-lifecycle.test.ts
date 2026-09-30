import { spawn as spawnProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const foundry = vi.hoisted(() => ({ active: false, sessions: 0 }));
vi.mock("foundry-local-sdk", () => ({
  FoundryLocalManager: {
    createAsync: async () => {
      if (foundry.active) throw new Error("Manager already created. Call Destroy() first.");
      foundry.active = true;
      const model = {
        id: "test-model",
        load: async () => {},
        unload: async () => {
          if (foundry.sessions) throw new Error("cannot unload model: 1 session(s) still using it");
        },
        createAudioClient: () => ({
          dispose() {},
          createLiveTranscriptionSession: () => {
            let finishStream = () => {};
            const stopped = new Promise<void>((resolve) => {
              finishStream = resolve;
            });
            return {
              settings: {},
              start: async () => {
                foundry.sessions += 1;
              },
              append: async () => {},
              stop: async () => {
                finishStream();
              },
              dispose: async () => {
                foundry.sessions = 0;
              },
              async *getStream() {
                yield { content: [{ text: "Hel" }], is_final: false };
                await stopped;
                yield { content: [{ text: "Hello" }], is_final: true };
              },
            };
          },
        }),
      };
      return {
        catalog: { getModel: async () => ({ variants: [model] }) },
        dispose() {
          foundry.active = false;
        },
      };
    },
  },
}));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: () =>
      original.spawn(
        process.execPath,
        ["-e", "setInterval(() => process.stdout.write(Buffer.from([0, 0])), 10)"],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
  };
});

function recordingUI(key: string, consumed: unknown[]) {
  return {
    setWidget: vi.fn(),
    custom: vi.fn(() => {
      throw new Error("Recording must keep the normal editor visible");
    }),
    onTerminalInput: vi.fn((listener: Parameters<ExtensionUIContext["onTerminalInput"]>[0]) => {
      const timer = setTimeout(() => consumed.push(listener(key)), 100);
      return vi.fn(() => clearTimeout(timer));
    }),
  };
}

const choice = { alias: "nemotron-speech-streaming-en-0.6b", id: "test-model" };

describe("live dictation lifecycle", () => {
  it.skipIf(process.platform !== "darwin")(
    "publishes partial text and refreshes the visible editor before Enter",
    async () => {
      const { transcribeLive } = await import("./live.js");
      let handleInput: Parameters<ExtensionUIContext["onTerminalInput"]>[0] | undefined;
      const unsubscribe = vi.fn();
      const ui = {
        setWidget: vi.fn(),
        onTerminalInput: (listener: Parameters<ExtensionUIContext["onTerminalInput"]>[0]) => {
          handleInput = listener;
          return unsubscribe;
        },
      };
      const updates: string[] = [];
      let partialReceived = () => {};
      const partial = new Promise<void>((resolve) => {
        partialReceived = resolve;
      });
      const operation = transcribeLive(choice, "/tmp/test-cache", ui, (text) => {
        updates.push(text);
        partialReceived();
      });
      await partial;
      expect(updates).toEqual(["Hel"]);
      expect(ui.setWidget).toHaveBeenLastCalledWith("voice-dictation", [
        `Microphone listening: ${choice.alias}. Enter to stop, Esc to cancel.`,
      ]);
      expect(handleInput?.("\r")).toEqual({ consume: true });
      await expect(operation).resolves.toBe("Hello");
      expect(updates).toEqual(["Hel", "Hello"]);
      expect(unsubscribe).toHaveBeenCalledOnce();
    },
  );
  it.skipIf(process.platform !== "darwin")(
    "returns the transcript after Enter without leaving a session that prevents model unload",
    async () => {
      const { transcribeLive } = await import("./live.js");
      await expect(transcribeLive(choice, "/tmp/test-cache", recordingUI("\r", []))).resolves.toBe(
        "Hello",
      );
    },
  );
  it.skipIf(process.platform !== "darwin")(
    "allows cancellation after the extension module reloads without creating a second native manager",
    async () => {
      const first = await import("./live.js");
      await expect(
        first.transcribeLive(choice, "/tmp/test-cache", recordingUI("\r", [])),
      ).resolves.toBe("Hello");
      vi.resetModules();
      const { transcribeLive } = await import("./live.js");
      await expect(
        transcribeLive(choice, "/tmp/test-cache", recordingUI("\u001b", [])),
      ).resolves.toBeUndefined();
    },
  );

  it("keeps the normal editor visible and consumes Enter without opening a custom screen", async () => {
    const { recordLiveSession } = await import("./live.js");
    const recorder = spawnProcess("ignored", [], { stdio: ["ignore", "pipe", "pipe"] });
    const session = {
      start: async () => {},
      append: async () => {},
      stop: async () => {},
      async *getStream() {
        yield { content: [{ text: "Hello" }], is_final: true };
      },
    };
    const consumed: unknown[] = [];
    const ui = recordingUI("\r", consumed);
    await recordLiveSession(session, recorder, ui);
    expect(ui.custom).not.toHaveBeenCalled();
    expect(consumed).toEqual([{ consume: true }]);
    expect(ui.onTerminalInput.mock.results[0]?.value).toHaveBeenCalledOnce();
  });
});
