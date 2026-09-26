import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { IModel, LiveAudioTranscriptionSession } from "foundry-local-sdk";

type Session = Pick<LiveAudioTranscriptionSession, "start" | "append" | "stop" | "getStream">;
type ModelChoice = { alias: string; id: string };

type RecordingUI = {
  custom<T>(
    factory: (
      tui: unknown,
      theme: { fg: (color: "accent", text: string) => string },
      keybindings: unknown,
      done: (result: T) => void,
    ) => { render(width: number): string[]; invalidate(): void; handleInput(data: string): void },
  ): Promise<T>;
};

export const microphoneInputArgs = [
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
];

export async function transcribePcm(
  session: Session,
  pcm: AsyncIterable<Uint8Array>,
): Promise<string> {
  await session.start();
  const read = (async () => {
    const segments: string[] = [];
    for await (const result of session.getStream()) {
      const text = result.content?.[0]?.text?.trim();
      if (result.is_final && text) segments.push(text);
    }
    return segments.join(" ");
  })();
  // Observe reader errors immediately, even if audio capture is still running.
  const settled = read.then(
    (text) => ({ text, error: undefined }),
    (error: unknown) => ({ text: "", error }),
  );
  try {
    for await (const chunk of pcm) await session.append(chunk);
  } finally {
    await session.stop();
  }
  const result = await settled;
  if (result.error) throw result.error;
  return result.text;
}

let managerPromise:
  | ReturnType<(typeof import("foundry-local-sdk"))["FoundryLocalManager"]["createAsync"]>
  | undefined;

async function getModel(choice: ModelChoice, cacheDir: string): Promise<IModel> {
  const { FoundryLocalManager } = await import("foundry-local-sdk");
  managerPromise ??= FoundryLocalManager.createAsync({
    appName: "pi_voice_dictation",
    modelCacheDir: cacheDir,
    logLevel: "error",
  });
  const manager = await managerPromise;
  const model = await manager.catalog.getModel(choice.alias);
  const variant = model?.variants.find((candidate) => candidate.id === choice.id);
  if (!variant) throw new Error(`Foundry Local cannot find ${choice.id}`);
  return variant;
}

export async function downloadModel(
  choice: ModelChoice,
  cacheDir: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  const model = await getModel(choice, cacheDir);
  if (!model.isCached) await model.download(onProgress);
}

export async function transcribeLive(
  choice: ModelChoice,
  cacheDir: string,
  ui: Pick<ExtensionUIContext, "custom" | "setWidget">,
): Promise<string | undefined> {
  if (process.platform !== "darwin")
    throw new Error("Microphone recording currently requires macOS");
  const model = await getModel(choice, cacheDir);
  await model.load();
  try {
    const session = model.createAudioClient().createLiveTranscriptionSession();
    session.settings.sampleRate = 16000;
    session.settings.channels = 1;
    session.settings.bitsPerSample = 16;
    session.settings.language = choice.alias.includes("-en-") ? "en" : "auto";

    const recorder = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        ...microphoneInputArgs,
        "-f",
        "s16le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      ui.setWidget("voice-dictation", [
        `Microphone listening: ${choice.alias}. Enter to stop, Esc to cancel.`,
      ]);
      return await recordLiveSession(session, recorder, ui);
    } catch (error) {
      if (recorder.exitCode === null) recorder.kill("SIGINT");
      throw error;
    } finally {
      ui.setWidget("voice-dictation", undefined);
    }
  } finally {
    await model.unload();
  }
}

export async function recordLiveSession(
  session: Session,
  recorder: ChildProcessByStdio<null, Readable, Readable>,
  ui: RecordingUI,
): Promise<string | undefined> {
  let stderr = "";
  recorder.stderr.setEncoding("utf8");
  recorder.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-2048);
  });
  let failure: Error | undefined;
  let finish: ((value: "stop" | "cancel" | "failed") => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    recorder.once("error", (error) => {
      failure = error;
      finish?.("failed");
    });
    recorder.once("close", (code) => {
      if (
        code !== 0 &&
        recorder.signalCode !== "SIGINT" &&
        !(code === 255 && (choiceResult === "stop" || choiceResult === "cancel"))
      )
        failure ??= new Error(
          `Microphone recording failed: ${stderr.trim() || `ffmpeg exited with code ${code}`}`,
        );
      finish?.("failed");
      resolve();
    });
  });
  const task = transcribePcm(session, recorder.stdout);
  // A microphone or SDK failure must close the recording dialog.
  task.then(
    () => finish?.("failed"),
    (error) => {
      failure = error instanceof Error ? error : new Error(String(error));
      finish?.("failed");
    },
  );
  let choiceResult: "stop" | "cancel" | "failed" = "failed";
  try {
    choiceResult = await ui.custom<"stop" | "cancel" | "failed">((_tui, theme, _kb, done) => {
      finish = done;
      if (failure || recorder.exitCode !== null) queueMicrotask(() => done("failed"));
      return {
        render: (width) => [
          truncateToWidth(
            theme.fg(
              "accent",
              "Microphone listening. Foundry Local is transcribing. Enter to stop, Esc to cancel.",
            ),
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
  const text = await task;
  if (failure) throw failure;
  if (choiceResult === "failed") throw new Error("Live microphone capture stopped unexpectedly");
  return choiceResult === "cancel" ? undefined : text;
}
