import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  getAgentDir,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { downloadModel, microphoneInputArgs, transcribeLive } from "./live.js";

const execFileAsync = promisify(execFile);

type SpeechModel = { alias: string; id: string; cached: boolean; sizeMb: number };
type RunFoundry = (args: string[]) => Promise<string>;
export type DictationUI = Pick<
  ExtensionUIContext,
  "select" | "confirm" | "notify" | "setWidget" | "getEditorText" | "setEditorText" | "custom"
>;
export type DictationContext = Pick<ExtensionContext, "mode"> & { ui: DictationUI };
type DictationRegistration = {
  registerCommand: (
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: DictationContext) => Promise<void>;
    },
  ) => void;
  registerShortcut: (
    shortcut: string,
    options: { description: string; handler: (ctx: DictationContext) => Promise<void> },
  ) => void;
};

const ObjectSchema = Type.Record(Type.String(), Type.Unknown());
const MissingFileSchema = Type.Object({ code: Type.Literal("ENOENT") });
const SavedModelSchema = Type.Object({ model: Type.String() });
const CacheLocationSchema = Type.Object({ path: Type.String() });
const SpeechVariantSchema = Type.Object({
  alias: Type.String(),
  variantId: Type.String(),
  cached: Type.Boolean(),
  fileSizeMb: Type.Number(),
});
const SpeechVariantsSchema = Type.Object({ variants: Type.Array(Type.Unknown()) });
const TranscriptSchema = Type.Object({ text: Type.String() });

async function readSettings(path: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (Value.Check(MissingFileSchema, error)) return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (!Value.Check(ObjectSchema, value)) throw new Error(`${path} must contain an object`);
  return value;
}

function savedModel(settings: Record<string, unknown>, path: string): string | undefined {
  const choice = settings.voiceDictation;
  if (choice === undefined) return undefined;
  if (!Value.Check(SavedModelSchema, choice))
    throw new Error(`${path}: voiceDictation.model must be a string`);
  return choice.model;
}

async function saveModel({ path, id }: { path: string; id: string }): Promise<void> {
  await withFileMutationQueue(path, async () => {
    const settings = await readSettings(path);
    const previous = settings.voiceDictation;
    if (previous !== undefined && !Value.Check(ObjectSchema, previous))
      throw new Error(`${path}: voiceDictation must be an object`);
    settings.voiceDictation = {
      ...(Value.Check(ObjectSchema, previous) ? previous : {}),
      model: id,
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
  });
}

type DictationDependencies = {
  listModels: () => Promise<SpeechModel[]>;
  record: (file: string, ui: Pick<ExtensionUIContext, "custom">) => Promise<boolean>;
  transcribe: (file: string, model: string) => Promise<string>;
  liveTranscribe: (
    model: SpeechModel,
    ui: Pick<ExtensionUIContext, "custom" | "setWidget">,
  ) => Promise<string | undefined>;
  download: (model: SpeechModel, onProgress: (percent: number) => void) => Promise<void>;
};

async function runFoundry(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("foundry", args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function foundryCacheDir(): Promise<string> {
  const value: unknown = JSON.parse(await runFoundry(["cache", "location", "--output", "json"]));
  if (!Value.Check(CacheLocationSchema, value)) {
    throw new Error("Foundry returned an invalid cache location");
  }
  return value.path;
}

export async function listSpeechModels(run: RunFoundry = runFoundry): Promise<SpeechModel[]> {
  const value: unknown = JSON.parse(
    await run(["model", "list", "--type", "speech", "--variants", "--output", "json"]),
  );
  if (!Value.Check(SpeechVariantsSchema, value)) {
    throw new Error("Foundry returned an invalid speech model list");
  }
  return value.variants.map((model: unknown) => {
    if (!Value.Check(SpeechVariantSchema, model)) {
      throw new Error("Foundry returned an invalid speech model");
    }
    return {
      alias: model.alias,
      id: model.variantId,
      cached: model.cached,
      sizeMb: model.fileSizeMb,
    };
  });
}

export async function transcribeFile({
  run,
  file,
  model,
}: {
  run: RunFoundry;
  file: string;
  model: string;
}): Promise<string> {
  const value: unknown = JSON.parse(
    await run(["transcribe", "--model", model, "--file", file, "--output", "json"]),
  );
  if (!Value.Check(TranscriptSchema, value)) {
    throw new Error("Foundry returned an invalid transcript");
  }
  return value.text.trim();
}

async function recordMicrophone(
  file: string,
  ui: Pick<ExtensionUIContext, "custom">,
): Promise<boolean> {
  if (process.platform !== "darwin")
    throw new Error("Microphone recording currently requires macOS");
  const recorder = spawn(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-nostdin", ...microphoneInputArgs, "-y", file],
    { stdio: "ignore" },
  );
  let failure: Error | undefined;
  let finish: ((value: "stop" | "cancel" | "failed") => void) | undefined;
  const closed = new Promise<number | null>((resolve) => {
    recorder.once("error", (error) => {
      failure = error;
      finish?.("failed");
    });
    recorder.once("close", (code) => {
      resolve(code);
      finish?.("failed");
    });
  });
  let choice: "stop" | "cancel" | "failed" = "failed";
  try {
    choice = await ui.custom<"stop" | "cancel" | "failed">((_tui, theme, _kb, done) => {
      finish = done;
      if (failure || recorder.exitCode !== null) queueMicrotask(() => done("failed"));
      return {
        render: (width) => [
          truncateToWidth(
            theme.fg("accent", "Recording microphone. Enter to stop, Esc to cancel."),
            width,
          ),
        ],
        invalidate() {},
        handleInput(data) {
          if (matchesKey(data, "return")) done("stop");
          else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done("cancel");
        },
      };
    });
  } finally {
    finish = undefined;
    if (recorder.exitCode === null) recorder.kill("SIGINT");
    await closed;
  }
  if (failure) throw failure;
  if (choice === "failed")
    throw new Error("Microphone recording failed. Check ffmpeg and microphone access.");
  if (choice === "cancel") return false;
  const audio = await stat(file);
  if (audio.size <= 44) throw new Error("No audio was recorded. Check microphone access.");
  return true;
}

function addTranscript(ui: DictationUI, text: string): void {
  const current = ui.getEditorText();
  ui.setEditorText(current ? `${current}\n${text}` : text);
  ui.notify("Dictation added to editor. Review it before sending.", "info");
}

function voiceDictation(
  pi: DictationRegistration,
  dependencies: DictationDependencies = {
    listModels: () => listSpeechModels(),
    record: recordMicrophone,
    transcribe: (file, model) => transcribeFile({ run: runFoundry, file, model }),
    liveTranscribe: async (model, ui) => transcribeLive(model, await foundryCacheDir(), ui),
    download: async (model, onProgress) =>
      downloadModel(model, await foundryCacheDir(), onProgress),
  },
  settingsPath = join(getAgentDir(), "settings.json"),
) {
  async function dictate(ctx: DictationContext, chooseModel: boolean) {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/dictate requires Pi's terminal UI", "error");
      return;
    }
    try {
      const stored = chooseModel
        ? undefined
        : savedModel(await readSettings(settingsPath), settingsPath);
      if (!chooseModel && !stored) {
        ctx.ui.notify("Choose a dictation model first with /dictate model", "warning");
        return;
      }
      const models = await dependencies.listModels();
      if (models.length === 0) {
        ctx.ui.notify("Foundry Local has no speech models available", "error");
        return;
      }
      let model: SpeechModel | undefined;
      if (chooseModel) {
        const options = models.map(
          (item) =>
            `${item.alias} | ${item.id} | ${item.cached ? "cached" : `download ${item.sizeMb} MB`}`,
        );
        const selected = await ctx.ui.select("Foundry Local speech model", options);
        model = models[options.indexOf(selected ?? "")];
        if (!model) return;
        await saveModel({ path: settingsPath, id: model.id });
        ctx.ui.notify(`Dictation model set to ${model.alias}`, "info");
        return;
      }
      model = models.find((item) => item.id === stored);
      if (!model) {
        ctx.ui.notify(
          "Saved dictation model is unavailable. Choose another with /dictate model",
          "warning",
        );
        return;
      }
      if (
        !model.cached &&
        !(await ctx.ui.confirm(
          "Download speech model?",
          `${model.id} needs about ${model.sizeMb} MB. Foundry will download it before transcription.`,
        ))
      )
        return;

      if (!model.cached) {
        try {
          ctx.ui.setWidget("voice-dictation", [`Downloading ${model.alias}...`]);
          await dependencies.download(model, (percent) => {
            ctx.ui.setWidget("voice-dictation", [
              `Downloading ${model.alias}: ${percent.toFixed(1)}%`,
            ]);
          });
        } finally {
          ctx.ui.setWidget("voice-dictation", undefined);
        }
      }

      if (model.alias.startsWith("nemotron-") && model.alias.includes("streaming")) {
        let text: string | undefined;
        try {
          ctx.ui.setWidget("voice-dictation", [`Preparing ${model.alias} microphone...`]);
          text = await dependencies.liveTranscribe(model, ctx.ui);
        } finally {
          ctx.ui.setWidget("voice-dictation", undefined);
        }
        if (text) {
          addTranscript(ctx.ui, text);
        }
        return;
      }

      const directory = await mkdtemp(join(tmpdir(), "pi-dictation-"));
      const file = join(directory, "recording.wav");
      try {
        if (!(await dependencies.record(file, ctx.ui))) return;
        ctx.ui.notify(`Transcribing with ${model.alias}...`, "info");
        const text = await dependencies.transcribe(file, model.id);
        if (!text) {
          ctx.ui.notify("No speech detected", "warning");
          return;
        }
        addTranscript(ctx.ui, text);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    } catch (error) {
      ctx.ui.notify(
        `Dictation failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  pi.registerCommand("dictate", {
    description: "Dictate with the saved model; /dictate model selects a model",
    handler: async (args, ctx) => {
      if (args.trim() !== "" && args.trim() !== "model") {
        ctx.ui.notify("Usage: /dictate [model]", "warning");
        return;
      }
      await dictate(ctx, args.trim() === "model");
    },
  });
  pi.registerShortcut("ctrl+alt+r", {
    description: "Start voice dictation with the saved model",
    handler: async (ctx) => dictate(ctx, false),
  });
}

export default voiceDictation satisfies (
  pi: Pick<ExtensionAPI, "registerCommand" | "registerShortcut">,
) => void;
