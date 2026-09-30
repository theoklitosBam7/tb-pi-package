import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { IModel, LiveAudioTranscriptionSession } from "foundry-local-sdk";

type Session = Pick<LiveAudioTranscriptionSession, "start" | "append" | "stop" | "getStream">;
type ModelChoice = { alias: string; id: string };

type RecordingUI = Pick<ExtensionUIContext, "onTerminalInput">;

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
  onTranscript?: (text: string) => void,
): Promise<string> {
  await session.start();
  const read = (async () => {
    const segments: string[] = [];
    let partial = "";
    for await (const result of session.getStream()) {
      const text = result.content?.[0]?.text;
      if (text === undefined || text === null) continue;
      if (result.is_final) {
        if (text.trim()) segments.push(text.trim());
        partial = "";
      } else {
        partial += text;
      }
      onTranscript?.([...segments, partial.trim()].filter(Boolean).join(" "));
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

async function withModel<T>(
  choice: ModelChoice,
  cacheDir: string,
  run: (model: IModel) => Promise<T>,
): Promise<T> {
  const { FoundryLocalManager } = await import("foundry-local-sdk");
  const manager = await FoundryLocalManager.createAsync({
    appName: "pi_voice_dictation",
    modelCacheDir: cacheDir,
    logLevel: "error",
  });
  try {
    const model = await manager.catalog.getModel(choice.alias);
    const variant = model?.variants.find((candidate) => candidate.id === choice.id);
    if (!variant) throw new Error(`Foundry Local cannot find ${choice.id}`);
    return await run(variant);
  } finally {
    manager.dispose();
  }
}

export async function downloadModel(
  choice: ModelChoice,
  cacheDir: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  await withModel(choice, cacheDir, async (model) => {
    if (!model.isCached) await model.download(onProgress);
  });
}

export async function transcribeLive(
  choice: ModelChoice,
  cacheDir: string,
  ui: RecordingUI & Pick<ExtensionUIContext, "setWidget">,
  onTranscript?: (text: string) => void,
): Promise<string | undefined> {
  if (process.platform !== "darwin")
    throw new Error("Microphone recording currently requires macOS");
  return withModel(choice, cacheDir, async (model) => {
    await model.load();
    try {
      const client = model.createAudioClient();
      try {
        const session = client.createLiveTranscriptionSession();
        try {
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
            return await recordLiveSession(session, recorder, ui, (text) => {
              onTranscript?.(text);
              // setEditorText does not request a render; refreshing the widget does.
              ui.setWidget("voice-dictation", [
                `Microphone listening: ${choice.alias}. Enter to stop, Esc to cancel.`,
              ]);
            });
          } catch (error) {
            if (recorder.exitCode === null) recorder.kill("SIGINT");
            throw error;
          } finally {
            ui.setWidget("voice-dictation", undefined);
          }
        } finally {
          await session.dispose();
        }
      } finally {
        client.dispose();
      }
    } finally {
      await model.unload();
    }
  });
}

export async function recordLiveSession(
  session: Session,
  recorder: ChildProcessByStdio<null, Readable, Readable>,
  ui: RecordingUI,
  onTranscript?: (text: string) => void,
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
  const task = transcribePcm(session, recorder.stdout, onTranscript);
  // A microphone or SDK failure must stop capture even without keyboard input.
  let taskFinished = false;
  task.then(
    () => {
      taskFinished = true;
      finish?.("failed");
    },
    (error) => {
      taskFinished = true;
      failure = error instanceof Error ? error : new Error(String(error));
      finish?.("failed");
    },
  );
  let choiceResult: "stop" | "cancel" | "failed" = "failed";
  let unsubscribe: (() => void) | undefined;
  try {
    try {
      choiceResult = await new Promise<"stop" | "cancel" | "failed">((resolve) => {
        finish = resolve;
        unsubscribe = ui.onTerminalInput((data) => {
          if (matchesKey(data, "return")) finish?.("stop");
          else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) finish?.("cancel");
          return { consume: true };
        });
        if (failure || taskFinished || recorder.exitCode !== null)
          queueMicrotask(() => resolve("failed"));
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
  } finally {
    unsubscribe?.();
  }
}
