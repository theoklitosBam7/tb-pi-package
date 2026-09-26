import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import voiceDictation, { listSpeechModels, transcribeFile } from "./index.js";

describe("Foundry speech commands", () => {
  it("lists speech variants with their exact versioned IDs", async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({
        variants: [
          {
            alias: "nemotron-speech-streaming-en-0.6b",
            variantId: "nemotron-speech-streaming-en-0.6b-generic-cpu:3",
            cached: true,
            fileSizeMb: 696,
          },
          {
            alias: "nemotron-3.5-asr-streaming-0.6b",
            variantId: "nemotron-3.5-asr-streaming-0.6b-generic-cpu:3",
            cached: false,
            fileSizeMb: 756,
          },
        ],
      }),
    );
    const models = await listSpeechModels(run);
    expect(models).toEqual([
      {
        alias: "nemotron-speech-streaming-en-0.6b",
        id: "nemotron-speech-streaming-en-0.6b-generic-cpu:3",
        cached: true,
        sizeMb: 696,
      },
      {
        alias: "nemotron-3.5-asr-streaming-0.6b",
        id: "nemotron-3.5-asr-streaming-0.6b-generic-cpu:3",
        cached: false,
        sizeMb: 756,
      },
    ]);
    expect(run).toHaveBeenCalledWith([
      "model",
      "list",
      "--type",
      "speech",
      "--variants",
      "--output",
      "json",
    ]);
  });

  it("transcribes an audio file with the selected model", async () => {
    const run = vi.fn().mockResolvedValue('{"text":"Turn left at the next street."}');
    expect(
      await transcribeFile(
        run,
        "/tmp/recording.wav",
        "nemotron-3.5-asr-streaming-0.6b-generic-cpu:3",
      ),
    ).toBe("Turn left at the next street.");
    expect(run).toHaveBeenCalledWith([
      "transcribe",
      "--model",
      "nemotron-3.5-asr-streaming-0.6b-generic-cpu:3",
      "--file",
      "/tmp/recording.wav",
      "--output",
      "json",
    ]);
  });
});

const settingsDirs: string[] = [];
async function settingsFile(modelId?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-dictation-settings-"));
  settingsDirs.push(directory);
  const path = join(directory, "settings.json");
  if (modelId)
    await writeFile(path, JSON.stringify({ theme: "dark", voiceDictation: { model: modelId } }));
  return path;
}
afterEach(async () => {
  await Promise.all(settingsDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("/dictate", () => {
  it("shows download progress before recording an uncached model", async () => {
    type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
    let command: CommandOptions | undefined;
    const extension: Pick<ExtensionAPI, "registerCommand" | "registerShortcut"> = {
      registerShortcut() {},
      registerCommand(name, options) {
        if (name === "dictate") command = options;
      },
    };
    const model = {
      alias: "whisper-tiny",
      id: "openai-whisper-tiny-generic-cpu:4",
      cached: false,
      sizeMb: 131,
    };
    const record = vi.fn().mockResolvedValue(false);
    const download = vi.fn().mockImplementation(async (_model, onProgress) => {
      onProgress(24);
      onProgress(81);
    });
    voiceDictation(
      extension,
      {
        listModels: async () => [model],
        download,
        record,
        transcribe: vi.fn(),
        liveTranscribe: vi.fn(),
      },
      await settingsFile(model.id),
    );
    const widgets: Array<string[] | undefined> = [];
    await command?.handler("", {
      mode: "tui",
      ui: {
        select: async (_title: string, options: string[]) => options[0],
        confirm: async () => true,
        setWidget: (_key: string, content: string[] | undefined) => {
          widgets.push(content);
        },
        notify: vi.fn(),
      },
    } as never);
    expect(download).toHaveBeenCalledWith(model, expect.any(Function));
    expect(widgets).toEqual([
      [expect.stringContaining("Downloading")],
      [expect.stringContaining("24")],
      [expect.stringContaining("81")],
      undefined,
    ]);
    expect(record).toHaveBeenCalledOnce();
  });

  it("uses a live session for a Nemotron model that rejects audio files", async () => {
    type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
    let command: CommandOptions | undefined;
    const extension: Pick<ExtensionAPI, "registerCommand" | "registerShortcut"> = {
      registerShortcut() {},
      registerCommand(name, options) {
        if (name === "dictate") command = options;
      },
    };
    const model = {
      alias: "nemotron-speech-streaming-en-0.6b",
      id: "nemotron-speech-streaming-en-0.6b-generic-cpu:3",
      cached: true,
      sizeMb: 696,
    };
    const transcribe = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Model 'nemotron-speech-streaming-en-0.6b' only supports live-streaming transcription; it cannot transcribe an audio file.",
        ),
      );
    const liveTranscribe = vi.fn().mockResolvedValue("Live speech works.");
    voiceDictation(
      extension,
      {
        listModels: async () => [model],
        record: vi.fn().mockResolvedValue(true),
        transcribe,
        liveTranscribe,
        download: vi.fn(),
      },
      await settingsFile(model.id),
    );
    const setEditorText = vi.fn();
    await command?.handler("", {
      mode: "tui",
      ui: {
        select: async (_title: string, options: string[]) => options[0],
        getEditorText: () => "Before",
        setEditorText,
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
    } as never);
    expect(transcribe).not.toHaveBeenCalled();
    expect(liveTranscribe).toHaveBeenCalledWith(model, expect.anything());
    expect(setEditorText).toHaveBeenCalledWith("Before\nLive speech works.");
  });

  it("inserts the transcript after existing editor text without sending it", async () => {
    type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
    let command: CommandOptions | undefined;
    const extension: Pick<ExtensionAPI, "registerCommand" | "registerShortcut"> = {
      registerShortcut() {},
      registerCommand(name, options) {
        if (name === "dictate") command = options;
      },
    };
    const listModels = vi.fn().mockResolvedValue([
      {
        alias: "whisper-tiny",
        id: "openai-whisper-tiny-generic-cpu:4",
        cached: true,
        sizeMb: 131,
      },
    ]);
    const record = vi.fn().mockResolvedValue(true);
    const transcribe = vi.fn().mockResolvedValue("Turn left at the next street.");
    voiceDictation(
      extension,
      {
        listModels,
        record,
        transcribe,
        liveTranscribe: vi.fn(),
        download: vi.fn(),
      },
      await settingsFile("openai-whisper-tiny-generic-cpu:4"),
    );
    const setEditorText = vi.fn();
    const notify = vi.fn();
    await command?.handler("", {
      mode: "tui",
      ui: {
        select: async (_title: string, options: string[]) => options[0],
        getEditorText: () => "Before",
        setEditorText,
        notify,
      },
    } as never);
    expect(setEditorText).toHaveBeenCalledWith("Before\nTurn left at the next street.");
    expect(record).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledWith(
      expect.any(String),
      "openai-whisper-tiny-generic-cpu:4",
    );
  });

  it("selects a model with /dictate model and saves it without recording", async () => {
    const path = await settingsFile("old-id");
    const model = { alias: "whisper-tiny", id: "new-id", cached: true, sizeMb: 131 };
    let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
    const record = vi.fn();
    voiceDictation(
      {
        registerCommand: (_name, options) => {
          command = options;
        },
        registerShortcut() {},
      },
      {
        listModels: async () => [model],
        record,
        transcribe: vi.fn(),
        liveTranscribe: vi.fn(),
        download: vi.fn(),
      },
      path,
    );
    const notify = vi.fn();
    await command?.handler("model", {
      mode: "tui",
      ui: {
        select: async () => "whisper-tiny | new-id | cached",
        notify,
      },
    } as never);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      theme: "dark",
      voiceDictation: { model: "new-id" },
    });
    expect(record).not.toHaveBeenCalled();
  });

  it("asks for /dictate model when no model is saved", async () => {
    const path = await settingsFile();
    let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
    const listModels = vi.fn();
    voiceDictation(
      {
        registerCommand: (_name, options) => {
          command = options;
        },
        registerShortcut() {},
      },
      {
        listModels,
        record: vi.fn(),
        transcribe: vi.fn(),
        liveTranscribe: vi.fn(),
        download: vi.fn(),
      },
      path,
    );
    const notify = vi.fn();
    await command?.handler("", { mode: "tui", ui: { notify } } as never);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("/dictate model"), "warning");
    expect(listModels).not.toHaveBeenCalled();
  });

  it("asks for /dictate model if the saved model is no longer available", async () => {
    const path = await settingsFile("old-id");
    let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
    const record = vi.fn();
    voiceDictation(
      {
        registerCommand: (_name, options) => {
          command = options;
        },
        registerShortcut() {},
      },
      {
        listModels: async () => [
          { alias: "whisper-tiny", id: "new-id", cached: true, sizeMb: 131 },
        ],
        record,
        transcribe: vi.fn(),
        liveTranscribe: vi.fn(),
        download: vi.fn(),
      },
      path,
    );
    const notify = vi.fn();
    await command?.handler("", { mode: "tui", ui: { notify } } as never);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("/dictate model"), "warning");
    expect(record).not.toHaveBeenCalled();
  });

  it("does not overwrite invalid user settings while selecting a model", async () => {
    const path = await settingsFile();
    await writeFile(path, "{bad json");
    let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
    voiceDictation(
      {
        registerCommand: (_name, options) => {
          command = options;
        },
        registerShortcut() {},
      },
      {
        listModels: async () => [
          { alias: "whisper-tiny", id: "new-id", cached: true, sizeMb: 131 },
        ],
        record: vi.fn(),
        transcribe: vi.fn(),
        liveTranscribe: vi.fn(),
        download: vi.fn(),
      },
      path,
    );
    const notify = vi.fn();
    await command?.handler("model", {
      mode: "tui",
      ui: {
        select: async () => "whisper-tiny | new-id | cached",
        notify,
      },
    } as never);
    expect(await readFile(path, "utf8")).toBe("{bad json");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("not valid JSON"), "error");
  });

  it("starts the saved live model from ctrl+alt+r without opening the selector", async () => {
    const model = {
      alias: "nemotron-speech-streaming-en-0.6b",
      id: "live-id",
      cached: true,
      sizeMb: 696,
    };
    const path = await settingsFile(model.id);
    let shortcut: Parameters<ExtensionAPI["registerShortcut"]>[1] | undefined;
    const liveTranscribe = vi.fn().mockImplementation(async (_model, ui) => {
      expect(ui.setWidget).toHaveBeenCalledWith("voice-dictation", [
        expect.stringContaining("Preparing"),
      ]);
      return "Spoken text";
    });
    voiceDictation(
      {
        registerCommand() {},
        registerShortcut: (key, options) => {
          expect(key).toBe("ctrl+alt+r");
          shortcut = options;
        },
      },
      {
        listModels: async () => [model],
        record: vi.fn(),
        transcribe: vi.fn(),
        liveTranscribe,
        download: vi.fn(),
      },
      path,
    );
    const select = vi.fn();
    const setEditorText = vi.fn();
    const setWidget = vi.fn();
    await shortcut?.handler({
      mode: "tui",
      ui: {
        select,
        setEditorText,
        getEditorText: () => "",
        setWidget,
        notify: vi.fn(),
      },
    } as never);
    expect(select).not.toHaveBeenCalled();
    expect(liveTranscribe).toHaveBeenCalledWith(model, expect.anything());
    expect(setEditorText).toHaveBeenCalledWith("Spoken text");
    expect(setWidget).toHaveBeenLastCalledWith("voice-dictation", undefined);
  });
});
