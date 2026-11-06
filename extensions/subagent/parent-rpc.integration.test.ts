import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

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
const localPi13Cli = path.join(getPackageDir(), "dist", "cli.js");
const versions = [
  { version: "1.3.0", cliPath: localPi13Cli },
  ...(fs.existsSync(installedPi15Cli)
    ? [{ version: "installed 1.5.0", cliPath: installedPi15Cli }]
    : []),
];

const temporaryDirectories: string[] = [];

type RpcRecord = Record<string, unknown>;
type ProviderEvent = { process: string; call: number; detail?: string };

function createFixture(): { project: string; agentDir: string; eventsPath: string } {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-parent-rpc-"));
  temporaryDirectories.push(project);
  const agentDir = path.join(project, "agent-dir");
  fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".pi", "agents", "worker.md"),
    "---\nname: worker\ndescription: Deterministic RPC fixture worker\nmodel: fixture/fixture-model\n---\n",
  );
  return { project, agentDir, eventsPath: path.join(project, "provider-events.jsonl") };
}

function writeProviderExtension(options: {
  extensionPath: string;
  eventsPath: string;
  piAiPath: string;
  busyReleasePath: string;
  childFirstReportReleasePath: string;
  childSecondReportReleasePath: string;
  childFinishReleasePath: string;
}): void {
  const source = `
import * as fs from "node:fs";
import * as path from "node:path";
import { createAssistantMessageEventStream } from ${JSON.stringify(options.piAiPath)};
const eventsPath = ${JSON.stringify(options.eventsPath)};
const busyReleasePath = ${JSON.stringify(options.busyReleasePath)};
const childFirstReportReleasePath = ${JSON.stringify(options.childFirstReportReleasePath)};
const childSecondReportReleasePath = ${JSON.stringify(options.childSecondReportReleasePath)};
const childFinishReleasePath = ${JSON.stringify(options.childFinishReleasePath)};
let calls = 0;
let activeParentCalls = 0;
function record(processName, call, detail) {
  fs.appendFileSync(eventsPath, JSON.stringify({ process: processName, call, detail }) + "\\n");
}
function waitForFile(filePath) {
  if (fs.existsSync(filePath)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(path.dirname(filePath), (_event, filename) => {
      if (filename === path.basename(filePath) && fs.existsSync(filePath)) {
        watcher.close();
        resolve();
      }
    });
    watcher.once("error", reject);
    if (fs.existsSync(filePath)) {
      watcher.close();
      resolve();
    }
  });
}
function assistantMessage(model, content, stopReason) {
  return {
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}
export default function (pi) {
  pi.registerProvider("fixture", {
    api: "openai-completions", baseUrl: "http://127.0.0.1/unused", apiKey: "fixture",
    models: [{ id: "fixture-model", name: "Fixture Model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 512 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        calls += 1;
        const child = process.env.SUBAGENT_MANAGED_CHILD === "1";
        const processName = child ? "child" : "parent";
        if (child) {
          record(processName, calls, calls === 1 ? process.env.SUBAGENT_REPORT_RUN_ID : undefined);
          if (calls === 1) {
            await waitForFile(childFirstReportReleasePath);
            return finish(stream, model, [{ type: "toolCall", id: "child-report-1", name: "report_to_parent",
              arguments: { message: "Child report one: ready for parent." } }], "toolUse");
          }
          if (calls === 2) {
            await waitForFile(childSecondReportReleasePath);
            return finish(stream, model, [{ type: "toolCall", id: "child-report-2", name: "report_to_parent",
              arguments: { message: "Child report two: parent is busy." } }], "toolUse");
          }
          if (calls === 3) {
            record(processName, calls, "waiting-for-parent-response");
            await waitForFile(childFinishReleasePath);
            return finish(stream, model, [{ type: "text", text: "Child accepted the steering message." }], "stop");
          }
          if (calls === 4) {
            const messages = JSON.stringify(context.messages);
            record(processName, calls, messages);
            if (!messages.includes("Parent response to report two: continue with the final check.")) {
              throw new Error("Child did not receive the parent's steering message");
            }
            return finish(stream, model, [{ type: "text", text: "Child completed after parent response." }], "stop");
          }
          throw new Error("Unexpected child model turn");
        }

        activeParentCalls += 1;
        record(processName, calls, JSON.stringify(context.messages));
        if (activeParentCalls > 1) record(processName, calls, "CONCURRENT_PARENT_MODEL_TURNS");
        try {
          if (calls === 1) {
            return finish(stream, model, [{ type: "toolCall", id: "launch-child", name: "agent",
              arguments: { async: true, agent: "worker", task: "Send two explicit progress reports, then finish.",
                agentScope: "project", confirmProjectAgents: false, model: "fixture/fixture-model" } }], "toolUse");
          }
          if (calls === 3) {
            await waitForFile(busyReleasePath);
            return finish(stream, model, [{ type: "text", text: "Parent busy turn finished." }], "stop");
          }
          if (calls === 4) {
            const reportNotification = context.messages.find((message) =>
              message.role === "user" &&
              JSON.stringify(message.content).includes("Child report two: parent is busy.")
            );
            const notificationText = typeof reportNotification?.content === "string"
              ? reportNotification.content
              : reportNotification?.content.map((part) => part.text ?? "").join(" ") ?? "";
            const runId = notificationText.match(/Subagent worker \\(([^)]+)\\) report/)?.[1];
            if (!runId) {
              throw new Error("Parent report notification did not include the reporting run ID");
            }
            record(processName, calls, JSON.stringify({ runId, source: notificationText }));
            return finish(stream, model, [{ type: "toolCall", id: "respond-to-child", name: "agent_send",
              arguments: { runId, message: "Parent response to report two: continue with the final check.", mode: "steer" } }], "toolUse");
          }
          const text = calls === 2 ? "Child started; parent can wait." : "Parent received report follow-up.";
          return finish(stream, model, [{ type: "text", text }], "stop");
        } finally {
          activeParentCalls -= 1;
        }
      })().catch((error) => {
        const failed = assistantMessage(model, [], "error");
        failed.errorMessage = String(error);
        stream.push({ type: "error", reason: "error", error: failed });
        stream.end();
      });
      return stream;
    },
  });
}
function finish(stream, model, content, stopReason) {
  const message = assistantMessage(model, content, stopReason);
  stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
  stream.push({ type: "done", reason: stopReason, message });
  stream.end();
}
`;
  fs.writeFileSync(options.extensionPath, source);
}

function readEvents(filePath: string): ProviderEvent[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProviderEvent);
}

function startPi(options: {
  cliPath: string;
  cwd: string;
  agentDir: string;
  extensionPaths: string[];
}): ReturnType<typeof spawn> {
  return spawn(
    process.execPath,
    [
      options.cliPath,
      "--mode",
      "rpc",
      "--no-session",
      "--model",
      "fixture/fixture-model",
      ...options.extensionPaths.flatMap((extension) => ["--extension", extension]),
    ],
    {
      cwd: options.cwd,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: options.agentDir,
        PI_CODING_AGENT_SESSION_DIR: path.join(options.agentDir, "sessions"),
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("real Pi parent/child RPC transport", () => {
  for (const runtime of versions) {
    it(`[process integration] ${runtime.version}: idle reports wake the parent and busy reports queue without overlapping turns`, async () => {
      if (process.platform === "win32") return;
      const { project, agentDir, eventsPath } = createFixture();
      const busyReleasePath = path.join(project, "release-parent-busy-turn");
      const childFirstReportReleasePath = path.join(project, "release-child-first-report");
      const childSecondReportReleasePath = path.join(project, "release-child-second-report");
      const childFinishReleasePath = path.join(project, "release-child-finish-turn");
      const testDirectory = path.dirname(fileURLToPath(import.meta.url));
      const piAiPath = path.resolve(
        testDirectory,
        "../../node_modules/@earendil-works/pi-ai/dist/index.js",
      );
      const providerPath = path.join(agentDir, "extensions", "fixture-provider.mjs");
      writeProviderExtension({
        extensionPath: providerPath,
        eventsPath,
        piAiPath,
        busyReleasePath,
        childFirstReportReleasePath,
        childSecondReportReleasePath,
        childFinishReleasePath,
      });
      fs.writeFileSync(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ extensions: [providerPath] }),
      );
      const extensionPath = path.join(testDirectory, "index.ts");
      const parent = startPi({
        cliPath: runtime.cliPath,
        cwd: project,
        agentDir,
        extensionPaths: [extensionPath],
      });
      const records: RpcRecord[] = [];
      let stdoutBuffer = "";
      let stderr = "";
      parent.stdout?.setEncoding("utf8");
      parent.stdout?.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        while (stdoutBuffer.includes("\n")) {
          const boundary = stdoutBuffer.indexOf("\n");
          const line = stdoutBuffer.slice(0, boundary);
          stdoutBuffer = stdoutBuffer.slice(boundary + 1);
          if (line) records.push(JSON.parse(line) as RpcRecord);
        }
      });
      parent.stderr?.setEncoding("utf8");
      parent.stderr?.on("data", (chunk: string) => (stderr += chunk));
      const waitFor = async (predicate: () => boolean): Promise<void> => {
        try {
          await expect.poll(predicate, { timeout: 25_000 }).toBe(true);
        } catch {
          throw new Error(
            `Timed out waiting for parent event. stderr: ${stderr}\nRPC: ${JSON.stringify(records)}\nProvider: ${JSON.stringify(readEvents(eventsPath))}`,
          );
        }
      };
      const send = (record: RpcRecord) => {
        parent.stdin?.write(`${JSON.stringify(record)}\n`);
      };
      try {
        send({
          id: "parent-prompt",
          type: "prompt",
          message: "Start the worker and wait for its reports.",
        });
        await waitFor(() => records.some((record) => record.type === "agent_settled"));
        await waitFor(() =>
          readEvents(eventsPath).some((event) => event.process === "child" && event.call === 1),
        );

        // Emit the first report only after the parent is idle, so it tests an idle wake-up.
        fs.writeFileSync(childFirstReportReleasePath, "release");
        await waitFor(() =>
          readEvents(eventsPath).some(
            (event) =>
              event.process === "parent" &&
              event.call === 3 &&
              event.detail?.includes("Child report one: ready for parent."),
          ),
        );

        // Hold the child after its first report until the parent has started the wake-up turn.
        await waitFor(() =>
          readEvents(eventsPath).some((event) => event.process === "child" && event.call === 2),
        );
        fs.writeFileSync(childSecondReportReleasePath, "release");
        await waitFor(() =>
          readEvents(eventsPath).some((event) => event.process === "parent" && event.call === 3),
        );

        // Hold the parent's report-triggered turn open while the child reports again.
        await waitFor(() =>
          readEvents(eventsPath).some((event) => event.process === "child" && event.call === 3),
        );
        const parentCallCountWhileBusy = readEvents(eventsPath).filter(
          (event) => event.process === "parent",
        ).length;
        expect(
          readEvents(eventsPath).some((event) => event.detail === "CONCURRENT_PARENT_MODEL_TURNS"),
        ).toBe(false);
        expect(parentCallCountWhileBusy).toBe(3);

        fs.writeFileSync(busyReleasePath, "release");
        await waitFor(() =>
          readEvents(eventsPath).some((event) => event.process === "parent" && event.call === 4),
        );
        const events = readEvents(eventsPath);
        expect(
          events.some(
            (event) =>
              event.process === "parent" &&
              event.call === 4 &&
              event.detail?.includes("Child report two: parent is busy."),
          ),
        ).toBe(true);
        expect(events.some((event) => event.detail === "CONCURRENT_PARENT_MODEL_TURNS")).toBe(
          false,
        );
        await waitFor(() =>
          readEvents(eventsPath).some((event) => event.process === "child" && event.call === 3),
        );
        const parentResponse = readEvents(eventsPath).find(
          (event) =>
            event.process === "parent" &&
            event.call === 4 &&
            event.detail?.includes('"source":"Subagent worker '),
        );
        expect(parentResponse?.detail).toContain("Child report two: parent is busy.");
        const childRunId = readEvents(eventsPath).find(
          (event) => event.process === "child" && event.call === 1,
        )?.detail;
        expect(parentResponse?.detail).toContain(`"runId":"${childRunId}"`);
        fs.writeFileSync(childFinishReleasePath, "release");
        await waitFor(() =>
          readEvents(eventsPath).some(
            (event) =>
              event.process === "child" &&
              event.call === 4 &&
              event.detail?.includes(
                "Parent response to report two: continue with the final check.",
              ),
          ),
        );
        await waitFor(() =>
          records.some(
            (record) =>
              record.type === "message_end" &&
              typeof record.message === "object" &&
              record.message !== null &&
              "content" in record.message &&
              JSON.stringify(record.message.content).includes("completed ("),
          ),
        );
        expect(stderr).not.toContain("Error");
      } finally {
        if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          if (parent.exitCode !== null || parent.signalCode !== null) resolve();
          else parent.once("close", () => resolve());
        });
      }
    }, 60_000);
  }
});
