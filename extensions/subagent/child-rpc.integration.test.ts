import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const installedPi15Cli =
  path.join(
    os.homedir(),
    ".pi",
    "agent",
    "install",
    "releases",
    "1.5.0",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
const cliVersions = [
  {
    name: "Pi 1.3",
    path: path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    available: true,
  },
  {
    name: "Pi 1.5 (installed)",
    path: installedPi15Cli,
    available: fs.existsSync(installedPi15Cli),
  },
];
const temporaryDirectories: string[] = [];

type RpcRecord = {
  type?: string;
  id?: string;
  command?: string;
  success?: boolean;
  data?: { disposition?: string };
  aborted?: boolean;
};

function createProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-child-rpc-"));
  temporaryDirectories.push(project);
  return project;
}

function waitForFile(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (fs.existsSync(filePath)) {
        resolve();
      } else if (Date.now() - startedAt > 15_000) {
        reject(new Error(`Timed out waiting for ${filePath}`));
      } else {
        setImmediate(check);
      }
    };
    check();
  });
}

function installFixtureProvider(project: string): {
  extensionPath: string;
  markers: Record<string, string>;
} {
  const extensionPath = path.join(project, "fixture-provider.mjs");
  const markers = {
    firstCall: path.join(project, "first-call"),
    releaseFirst: path.join(project, "release-first"),
    steerCall: path.join(project, "steer-call.json"),
    releaseSteer: path.join(project, "release-steer"),
    providerTurns: path.join(project, "provider-turns.jsonl"),
    releaseFollowUp: path.join(project, "release-follow-up"),
    abortCall: path.join(project, "abort-call"),
  };
  const piAiPath = pathToFileURL(
    path.resolve(repositoryRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"),
  ).href;
  fs.writeFileSync(
    extensionPath,
    `import * as fs from "node:fs";\n` +
      `import { createAssistantMessageEventStream } from ${JSON.stringify(piAiPath)};\n` +
      `const markers = ${JSON.stringify(markers)};\n` +
      `function userText(messages) { return messages.filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ") : "").join("\\n"); }\n` +
      `function waitForFile(filePath, signal) { return new Promise((resolve) => { const poll = () => { if (signal?.aborted) return resolve(false); if (fs.existsSync(filePath)) return resolve(true); setImmediate(poll); }; poll(); }); }\n` +
      `export default function (pi) {\n` +
      `  pi.registerProvider("local-fixture", { api: "openai-completions", baseUrl: "http://127.0.0.1/unused", apiKey: "unused", models: [{ id: "fixture-model", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 }],\n` +
      `    streamSimple(model, context, options) {\n` +
      `      const stream = createAssistantMessageEventStream();\n` +
      `      void (async () => {\n` +
      `        const text = userText(context.messages);\n` +
      `        const abortRun = text.includes("abort-checkpoint");\n` +
      `        if (abortRun) { await new Promise((resolve) => { if (options?.signal?.aborted) return resolve(); options?.signal?.addEventListener("abort", resolve, { once: true }); fs.writeFileSync(markers.abortCall, text); }); const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "aborted", timestamp: Date.now() }; stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "aborted", message }); stream.end(); return; }\n` +
      `        fs.appendFileSync(markers.providerTurns, JSON.stringify({ text }) + "\\n");\n` +
      `        if (text.includes("follow-up payload")) { await waitForFile(markers.releaseFollowUp, options?.signal); }\n` +
      `        else if (text.includes("steering payload")) { fs.writeFileSync(markers.steerCall, JSON.stringify(text)); await waitForFile(markers.releaseSteer, options?.signal); }\n` +
      `        else { fs.writeFileSync(markers.firstCall, "started"); await waitForFile(markers.releaseFirst, options?.signal); }\n` +
      `        if (options?.signal?.aborted) { stream.end(); return; }\n` +
      `        const message = { role: "assistant", content: [{ type: "text", text: "local fixture complete" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };\n` +
      `        stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end();\n` +
      `      })().catch((error) => { stream.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: String(error), timestamp: Date.now() } }); stream.end(); });\n` +
      `      return stream;\n` +
      `    },\n` +
      `  });\n` +
      `}\n`,
  );
  return { extensionPath, markers };
}

async function startRpc(cliPath: string, project: string, extensionPath: string) {
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "--mode",
      "rpc",
      "--no-session",
      "--extension",
      extensionPath,
      "--model",
      "local-fixture/fixture-model",
    ],
    {
      cwd: project,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: project,
        PI_CODING_AGENT_SESSION_DIR: path.join(project, "sessions"),
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const records: RpcRecord[] = [];
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const boundary = buffer.indexOf("\n");
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (line) records.push(JSON.parse(line) as RpcRecord);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  return {
    child,
    records,
    stderr: () => stderr,
    send(command: Record<string, unknown>) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    },
    async waitFor(predicate: (record: RpcRecord) => boolean) {
      await viWaitFor(() => {
        const match = records.find(predicate);
        if (!match) throw new Error(JSON.stringify({ stderr, records }));
      });
      const record = records.find(predicate);
      if (!record) throw new Error("RPC record disappeared");
      return record;
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once("close", () => resolve());
      });
    },
  };
}

async function viWaitFor(assertion: () => void): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt > 15_000) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe.each(cliVersions)("real child RPC contract: $name", ({ path: cliPath, available }) => {
  it.skipIf(!available)(
    "[process integration] delivers prompt, steer, and follow_up, and reports abort settlement",
    async () => {
      const project = createProject();
      const { extensionPath, markers } = installFixtureProvider(project);
      const rpc = await startRpc(cliPath, project, extensionPath);
      try {
        rpc.send({ id: "prompt", type: "prompt", message: "begin controlled checkpoint" });
        const promptResponse = await rpc.waitFor(
          (record) => record.type === "response" && record.id === "prompt",
        );
        expect(promptResponse.success).toBe(true);
        expect(promptResponse.data?.disposition).toBe("started");
        await waitForFile(markers.firstCall);

        rpc.send({ id: "steer", type: "steer", message: "steering payload green-marker" });
        const steerResponse = await rpc.waitFor(
          (record) => record.type === "response" && record.id === "steer",
        );
        expect(steerResponse.success).toBe(true);
        expect(steerResponse.data?.disposition).toBe("queued");
        fs.writeFileSync(markers.releaseFirst, "release");
        await waitForFile(markers.steerCall);
        expect(fs.readFileSync(markers.steerCall, "utf8")).toContain(
          "steering payload green-marker",
        );
        rpc.send({ id: "follow-up", type: "follow_up", message: "follow-up payload blue-marker" });
        const followUpResponse = await rpc.waitFor(
          (record) => record.type === "response" && record.id === "follow-up",
        );
        expect(followUpResponse.success).toBe(true);
        expect(followUpResponse.data?.disposition).toBe("queued");
        const settledCount = rpc.records.filter((record) => record.type === "agent_settled").length;
        fs.writeFileSync(markers.releaseSteer, "release");
        await viWaitFor(() => {
          const providerTurns = fs
            .readFileSync(markers.providerTurns, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { text: string });
          expect(
            providerTurns.some((turn) => turn.text.includes("follow-up payload blue-marker")),
          ).toBe(true);
        });
        const turnsBeforeFollowUpRelease = fs
          .readFileSync(markers.providerTurns, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { text: string });
        expect(
          turnsBeforeFollowUpRelease.some((turn) =>
            turn.text.includes("steering payload green-marker"),
          ),
        ).toBe(true);
        fs.writeFileSync(markers.releaseFollowUp, "release");
        const settled = await rpc.waitFor(
          (record) =>
            record.type === "agent_settled" &&
            rpc.records.filter((candidate) => candidate.type === "agent_settled").length >
              settledCount,
        );
        expect(
          rpc.records.filter((record) => record.type === "agent_settled").slice(settledCount),
        ).toHaveLength(1);
        expect(settled.aborted).toBe(false);

        rpc.send({ id: "abort-prompt", type: "prompt", message: "abort-checkpoint" });
        await waitForFile(markers.abortCall);
        rpc.send({ id: "abort", type: "abort" });
        const abortedSettled = await rpc.waitFor(
          (record) => record.type === "agent_settled" && record.aborted === true,
        );
        expect(abortedSettled.aborted).toBe(true);
        const abortResponse = await rpc.waitFor(
          (record) => record.type === "response" && record.id === "abort",
        );
        expect(abortResponse.success).toBe(true);
        const abortPrompt = await rpc.waitFor(
          (record) => record.type === "response" && record.id === "abort-prompt",
        );
        expect(abortPrompt.success).toBe(true);
      } finally {
        await rpc.close();
      }
    },
    45_000,
  );
});
