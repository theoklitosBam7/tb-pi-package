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
import { downloadModel, transcribeLive } from "./live.js";

const execFileAsync = promisify(execFile);

type SpeechModel = { alias: string; id: string; cached: boolean; sizeMb: number };
type RunFoundry = (args: string[]) => Promise<string>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (!isObject(value)) throw new Error(`${path} must contain an object`);
  return value;
}

function savedModel(settings: Record<string, unknown>, path: string): string | undefined {
  const choice = settings.voiceDictation;
  if (choice === undefined) return undefined;
  if (!isObject(choice) || typeof choice.model !== "string")
    throw new Error(`${path}: voiceDictation.model must be a string`);
  return choice.model;
}

async function saveModel(path: string, id: string): Promise<void> {
  await withFileMutationQueue(path, async () => {
    const settings = await readSettings(path);
    const previous = settings.voiceDictation;
    if (previous !== undefined && !isObject(previous))
      throw new Error(`${path}: voiceDictation must be an object`);
    settings.voiceDictation = { ...(isObject(previous) ? previous : {}), model: id };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
  });
}

type DictationDependencies = {
  listModels: () => Promise<SpeechModel[]>;
  record: (file: string, ui: ExtensionUIContext) => Promise<boolean>;
  transcribe: (file: string, model: string) => Promise<string>;
  liveTranscribe: (model: SpeechModel, ui: ExtensionUIContext) => Promise<string | undefined>;
  download: (model: SpeechModel, onProgress: (percent: number) => void) => Promise<void>;
};

async function runFoundry(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("foundry", args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function foundryCacheDir(): Promise<string> {
  const value: unknown = JSON.parse(await runFoundry(["cache", "location", "--output", "json"]));
  if (
    typeof value !== "object" ||
    value === null ||
    !("path" in value) ||
    typeof value.path !== "string"
  ) {
    throw new Error("Foundry returned an invalid cache location");
  }
  return value.path;
}

export async function listSpeechModels(run: RunFoundry = runFoundry): Promise<SpeechModel[]> {
  const value: unknown = JSON.parse(
    await run(["model", "list", "--type", "speech", "--variants", "--output", "json"]),
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !("variants" in value) ||
    !Array.isArray(value.variants)
  ) {
    throw new Error("Foundry returned an invalid speech model list");
  }
  return value.variants.map((model: unknown) => {
    if (
      typeof model !== "object" ||
      model === null ||
      !("alias" in model) ||
      typeof model.alias !== "string" ||
      !("variantId" in model) ||
      typeof model.variantId !== "string" ||
      !("cached" in model) ||
      typeof model.cached !== "boolean" ||
      !("fileSizeMb" in model) ||
      typeof model.fileSizeMb !== "number"
    ) {
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

export async function transcribeFile(
  run: RunFoundry,
  file: string,
  model: string,
): Promise<string> {
  const value: unknown = JSON.parse(
    await run(["transcribe", "--model", model, "--file", file, "--output", "json"]),
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !("text" in value) ||
    typeof value.text !== "string"
  ) {
    throw new Error("Foundry returned an invalid transcript");
  }
  return value.text.trim();
}

async function recordMicrophone(file: string, ui: ExtensionUIContext): Promise<boolean> {
  if (process.platform !== "darwin")
    throw new Error("Microphone recording currently requires macOS");
  const recorder = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "avfoundation",
      "-i",
      ":default",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-y",
      file,
    ],
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

export default function voiceDictation(
  pi: Pick<ExtensionAPI, "registerCommand" | "registerShortcut">,
  dependencies: DictationDependencies = {
    listModels: () => listSpeechModels(),
    record: recordMicrophone,
    transcribe: (file, model) => transcribeFile(runFoundry, file, model),
    liveTranscribe: async (model, ui) => transcribeLive(model, await foundryCacheDir(), ui),
    download: async (model, onProgress) =>
      downloadModel(model, await foundryCacheDir(), onProgress),
  },
  settingsPath = join(getAgentDir(), "settings.json"),
) {
  async function dictate(ctx: ExtensionContext, chooseModel: boolean) {
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
        await saveModel(settingsPath, model.id);
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
          const current = ctx.ui.getEditorText();
          ctx.ui.setEditorText(current ? `${current}\n${text}` : text);
          ctx.ui.notify("Dictation added to editor. Review it before sending.", "info");
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
        const current = ctx.ui.getEditorText();
        ctx.ui.setEditorText(current ? `${current}\n${text}` : text);
        ctx.ui.notify("Dictation added to editor. Review it before sending.", "info");
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
