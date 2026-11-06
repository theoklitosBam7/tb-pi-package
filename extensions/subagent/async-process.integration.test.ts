import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { createReportServer } from "./report.js";
import { buildArtifactPath } from "./result.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "node:child_process";
import subagentExtension from "./index.js";

const temporaryDirectories: string[] = [];

function createProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-async-process-"));
  temporaryDirectories.push(project);
  fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".pi", "agents", "worker.md"),
    "---\nname: worker\ndescription: Test worker\n---\n",
  );
  return project;
}

function registerSubagentTools(
  events: Record<string, (...args: any[]) => unknown> = {},
  notifications: Array<Record<string, any>> = [],
): Record<string, any> {
  const tools: Record<string, any> = {};
  subagentExtension({
    getThinkingLevel: () => undefined,
    on(event: string, handler: (...args: any[]) => unknown) {
      events[event] = handler;
    },
    sendMessage(message: Record<string, any>) {
      notifications.push(message);
    },
    registerTool(tool: any) {
      tools[tool.name] = tool;
    },
    registerCommand() {},
    registerShortcut() {},
  } as any);
  return tools;
}

function parseToolText(result: { content: Array<{ text?: string }> }): Record<string, any> {
  const text = result.content.find((item) => item.text)?.text;
  if (!text) throw new Error("Tool returned no text content");
  return JSON.parse(text);
}

afterEach(() => {
  vi.mocked(spawn).mockReset();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("asynchronous subagent process integration", () => {
  it("rejects asynchronous chains before scheduling child processes", async () => {
    const tools = registerSubagentTools();
    vi.mocked(spawn).mockClear();

    const result = await tools.agent.execute(
      "async-chain",
      {
        async: true,
        chain: [
          { agent: "worker", task: "First task" },
          { agent: "worker", task: "Second task" },
        ],
      },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        hasUI: false,
        sessionManager: { getSessionFile: () => "/tmp/subagent-async-chain.jsonl" },
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("asynchronous chains");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns a run ID while a real RPC child remains active", async () => {
    const project = createProject();
    vi.stubEnv("PI_CODING_AGENT_DIR", project);
    const readyPath = path.join(project, "child-ready");
    const releasePath = path.join(project, "child-release");
    const fixturePath = path.join(project, "rpc-child.cjs");
    fs.writeFileSync(
      fixturePath,
      [
        'const fs = require("node:fs");',
        'let input = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => {',
        "  input += chunk;",
        '  while (input.includes("\\n")) {',
        '    const boundary = input.indexOf("\\n");',
        "    const line = input.slice(0, boundary);",
        "    input = input.slice(boundary + 1);",
        "    const command = JSON.parse(line);",
        '    if (command.type === "prompt") {',
        '      fs.writeFileSync(process.env.SUBAGENT_FIXTURE_READY, "ready");',
        '      process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } }) + "\\n");',
        "      const poll = setInterval(() => {",
        "        if (!fs.existsSync(process.env.SUBAGENT_FIXTURE_RELEASE)) return;",
        "        clearInterval(poll);",
        '        process.stdout.write(JSON.stringify({ type: "agent_settled", aborted: false }) + "\\n");',
        "      }, 10);",
        "    }",
        "  }",
        "});",
        'process.stdin.on("end", () => process.exit(0));',
      ].join("\n"),
    );
    vi.stubEnv("SUBAGENT_FIXTURE_READY", readyPath);
    vi.stubEnv("SUBAGENT_FIXTURE_RELEASE", releasePath);
    const { spawn: realSpawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawn).mockImplementation((_command, _args, options) => {
      return realSpawn(process.execPath, [fixturePath], options) as never;
    });
    const tools = registerSubagentTools();
    const sessionFile = path.join(project, "session.jsonl");

    const launched = await tools.agent.execute(
      "async-single",
      {
        async: true,
        agent: "worker",
        task: "Stay active until released",
        agentScope: "project",
        confirmProjectAgents: false,
      },
      undefined,
      undefined,
      {
        cwd: project,
        hasUI: false,
        sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "test-session" },
      },
    );
    const launchedData = parseToolText(launched);
    const runId = launchedData.runs?.[0]?.id;

    expect(typeof runId).toBe("string");
    await vi.waitFor(() => expect(fs.existsSync(readyPath)).toBe(true));

    const status = await tools.agent_status.execute(
      "status-running-child",
      { runId },
      undefined,
      undefined,
      {
        cwd: project,
        hasUI: false,
        sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "test-session" },
      },
    );
    const statusData = parseToolText(status);

    expect(statusData.run?.id).toBe(runId);
    expect(["starting", "running"]).toContain(statusData.run?.state?.kind);

    fs.writeFileSync(releasePath, "release");
    await vi.waitFor(async () => {
      const completed = await tools.agent_status.execute(
        "status-completed-child",
        { runId },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "test-session" },
        },
      );
      expect(parseToolText(completed).run?.state?.kind).toBe("completed");
    });
  }, 10_000);

  it.runIf(process.platform !== "win32")(
    "[process integration] completes A while B reports, receives steering, and stays cancellable",
    async () => {
      const project = createProject();
      vi.stubEnv("PI_CODING_AGENT_DIR", project);
      const fixturePath = path.join(project, "rpc-batch-child.cjs");
      const aReadyPath = path.join(project, "a-ready");
      const bReadyPath = path.join(project, "b-ready");
      const bSteeredPath = path.join(project, "b-steered");
      fs.writeFileSync(
        fixturePath,
        [
          'const fs = require("node:fs");',
          'const net = require("node:net");',
          'let input = "";',
          'let runKind = "";',
          "let reported = false;",
          'process.stdin.setEncoding("utf8");',
          'const write = (record) => process.stdout.write(JSON.stringify(record) + "\\n");',
          'const response = (command, data = {}) => write({ type: "response", id: command.id, command: command.type, success: true, data });',
          'const settle = (aborted = false) => { write({ type: "agent_settled", aborted }); setTimeout(() => process.exit(0), 10); };',
          "const reportToParent = () => new Promise((resolve, reject) => {",
          "  const socket = net.createConnection(process.env.SUBAGENT_REPORT_SOCKET);",
          '  let answer = "";',
          '  socket.once("connect", () => socket.write(JSON.stringify({ runId: process.env.SUBAGENT_REPORT_RUN_ID, token: process.env.SUBAGENT_REPORT_TOKEN, reportId: "report-from-b", message: "B is active at its report checkpoint." }) + "\\n"));',
          '  socket.on("data", (chunk) => { answer += chunk; if (!answer.includes("\\n")) return; const decision = JSON.parse(answer); socket.end(); if (decision.accepted) resolve(); else reject(new Error(decision.reason)); });',
          '  socket.once("error", reject);',
          "});",
          'process.stdin.on("data", (chunk) => {',
          "  input += chunk;",
          '  while (input.includes("\\n")) {',
          '    const boundary = input.indexOf("\\n");',
          "    const line = input.slice(0, boundary);",
          "    input = input.slice(boundary + 1);",
          "    const command = JSON.parse(line);",
          '    if (command.type === "prompt") {',
          '      runKind = command.message.includes("A completes independently") ? "a" : "b";',
          '      response(command, { disposition: "started" });',
          '      if (runKind === "a") {',
          '        fs.writeFileSync(process.env.SUBAGENT_FIXTURE_A_READY, "ready");',
          '        const message = { role: "assistant", content: [{ type: "text", text: "A completed while B was active." }], api: "fixture", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };',
          '        write({ type: "message_start", message: { ...message, content: [], stopReason: "pending" } });',
          '        write({ type: "message_end", message });',
          '        write({ type: "agent_end", messages: [message], willRetry: false });',
          "        settle(false);",
          "      } else {",
          '        fs.writeFileSync(process.env.SUBAGENT_FIXTURE_B_READY, "ready");',
          '        write({ type: "agent_end", messages: [], willRetry: false });',
          "        void reportToParent().then(() => { reported = true; });",
          "      }",
          '    } else if (command.type === "steer" && runKind === "b") {',
          '      response(command, { disposition: "queued" });',
          '      fs.appendFileSync(process.env.SUBAGENT_FIXTURE_B_STEERED, command.message + "\\n");',
          '    } else if (command.type === "abort" && runKind === "b") {',
          "      response(command);",
          "      settle(true);",
          "    }",
          "  }",
          "});",
          'process.stdin.on("end", () => { if (!reported) process.exit(0); });',
        ].join("\n"),
      );
      vi.stubEnv("SUBAGENT_FIXTURE_A_READY", aReadyPath);
      vi.stubEnv("SUBAGENT_FIXTURE_B_READY", bReadyPath);
      vi.stubEnv("SUBAGENT_FIXTURE_B_STEERED", bSteeredPath);
      const { spawn: realSpawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      vi.mocked(spawn).mockImplementation((_command, _args, options) => {
        return realSpawn(process.execPath, [fixturePath], options) as never;
      });
      const notifications: Array<Record<string, any>> = [];
      const tools = registerSubagentTools({}, notifications);
      const sessionFile = path.join(project, "session.jsonl");
      const context = {
        cwd: project,
        hasUI: false,
        sessionManager: {
          getSessionFile: () => sessionFile,
          getSessionId: () => "parallel-test-session",
        },
      };

      let bRunId: string | undefined;
      try {
        const launched = await tools.agent.execute(
          "async-parallel",
          {
            async: true,
            agentScope: "project",
            confirmProjectAgents: false,
            tasks: [
              { agent: "worker", task: "A completes independently" },
              { agent: "worker", task: "B waits for parent control" },
            ],
          },
          undefined,
          undefined,
          context,
        );
        const runs = parseToolText(launched).runs;
        const aRunId = runs?.[0]?.id;
        bRunId = runs?.[1]?.id;
        expect(typeof aRunId).toBe("string");
        expect(typeof bRunId).toBe("string");
        await vi.waitFor(() => {
          expect(fs.existsSync(aReadyPath)).toBe(true);
          expect(fs.existsSync(bReadyPath)).toBe(true);
        });

        const statusFor = async (runId: string) => {
          const result = await tools.agent_status.execute(
            "read-run-status",
            { runId },
            undefined,
            undefined,
            context,
          );
          return parseToolText(result).run;
        };
        await vi.waitFor(async () => {
          const [aRun, bRun] = await Promise.all([statusFor(aRunId!), statusFor(bRunId!)]);
          expect(aRun?.state?.kind).toBe("completed");
          expect(["starting", "running"]).toContain(bRun?.state?.kind);
        });
        const aRun = await statusFor(aRunId);
        expect(aRun?.state?.result?.artifactPath).toBeTruthy();
        expect(fs.readFileSync(aRun.state.result.artifactPath, "utf8")).toContain(
          "A completed while B was active.",
        );

        await vi.waitFor(async () => {
          const bRun = await statusFor(bRunId!);
          expect(bRun?.reports).toContain("B is active at its report checkpoint.");
          expect(bRun?.state?.kind).toBe("running");
        });
        const sendResult = await tools.agent_send.execute(
          "steer-b",
          { runId: bRunId, message: "Focus on the marker code green.", mode: "steer" },
          undefined,
          undefined,
          context,
        );
        expect(parseToolText(sendResult)).toMatchObject({ kind: "accepted", outcome: "pending" });
        await vi.waitFor(() => expect(fs.existsSync(bSteeredPath)).toBe(true));
        expect(fs.readFileSync(bSteeredPath, "utf8").trim().split("\n")).toEqual([
          "Focus on the marker code green.",
        ]);
        await vi.waitFor(async () => {
          const bRun = await statusFor(bRunId!);
          expect(bRun?.messages[0]?.outcome).toBe("accepted-by-child");
          expect(bRun?.state?.kind).toBe("running");
        });

        const canceled = await tools.agent_cancel.execute(
          "cancel-b",
          { runId: bRunId },
          undefined,
          undefined,
          context,
        );
        expect(parseToolText(canceled)).toEqual({ canceled: true });
        let canceledRun: Record<string, any> | undefined;
        await vi.waitFor(async () => {
          canceledRun = await statusFor(bRunId!);
          expect(canceledRun?.state?.kind).toBe("aborted");
        });
        expect(canceledRun?.state?.result?.value?.termination).toEqual({
          kind: "abort",
          cleanup: "unknown",
        });
        await vi.waitFor(() => {
          const terminal = notifications.find(
            (notification) =>
              notification.customType === "subagent-result" &&
              notification.details.runId === bRunId,
          );
          expect(terminal?.details.results[0]?.termination).toEqual({
            kind: "abort",
            cleanup: "unknown",
          });
        });
      } finally {
        if (bRunId) {
          const state = await tools.agent_status.execute(
            "cleanup-status",
            { runId: bRunId },
            undefined,
            undefined,
            context,
          );
          if (parseToolText(state).run?.state?.kind === "running") {
            await tools.agent_cancel.execute(
              "cleanup-cancel",
              { runId: bRunId },
              undefined,
              undefined,
              context,
            );
          }
        }
      }
    },
    20_000,
  );

  it.runIf(process.platform !== "win32")(
    "[process integration] cancels queued work without claiming process cleanup is unknown",
    async () => {
      const project = createProject();
      vi.stubEnv("PI_CODING_AGENT_DIR", project);
      const fixturePath = path.join(project, "rpc-queued-child.cjs");
      const readyDirectory = path.join(project, "ready");
      fs.mkdirSync(readyDirectory);
      fs.writeFileSync(
        fixturePath,
        [
          'const fs = require("node:fs");',
          'let input = "";',
          'process.stdin.setEncoding("utf8");',
          'process.stdin.on("data", (chunk) => {',
          "  input += chunk;",
          '  while (input.includes("\\n")) {',
          '    const boundary = input.indexOf("\\n");',
          "    const command = JSON.parse(input.slice(0, boundary));",
          "    input = input.slice(boundary + 1);",
          '    if (command.type !== "prompt") continue;',
          "    const match = command.message.match(/queued-cancel-(\\d+)/);",
          '    const taskId = match ? match[1] : "unknown";',
          '    process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } }) + "\\n");',
          '    fs.writeFileSync(`${process.env.SUBAGENT_FIXTURE_READY_DIR}/${taskId}`, "ready");',
          "  }",
          "});",
        ].join("\n"),
      );
      vi.stubEnv("SUBAGENT_FIXTURE_READY_DIR", readyDirectory);
      const { spawn: realSpawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      vi.mocked(spawn).mockImplementation((_command, _args, options) => {
        return realSpawn(process.execPath, [fixturePath], options) as never;
      });
      const notifications: Array<Record<string, any>> = [];
      const tools = registerSubagentTools({}, notifications);
      const sessionFile = path.join(project, "session.jsonl");
      const context = {
        cwd: project,
        hasUI: false,
        sessionManager: {
          getSessionFile: () => sessionFile,
          getSessionId: () => "queued-cancel-session",
        },
      };
      const launched = await tools.agent.execute(
        "async-queued-cancel",
        {
          async: true,
          agentScope: "project",
          confirmProjectAgents: false,
          tasks: [1, 2, 3, 4, 5].map((number) => ({
            agent: "worker",
            task: `queued-cancel-${number}`,
          })),
        },
        undefined,
        undefined,
        context,
      );
      const runs = parseToolText(launched).runs;
      const queuedRunId = runs?.[4]?.id;
      expect(typeof queuedRunId).toBe("string");
      await vi.waitFor(() => {
        for (let number = 1; number <= 4; number += 1) {
          expect(fs.existsSync(path.join(readyDirectory, String(number)))).toBe(true);
        }
      });
      expect(fs.existsSync(path.join(readyDirectory, "5"))).toBe(false);

      const canceled = await tools.agent_cancel.execute(
        "cancel-queued-run",
        { runId: queuedRunId },
        undefined,
        undefined,
        context,
      );
      expect(parseToolText(canceled)).toEqual({ canceled: true });
      let queuedStatus: Record<string, any> | undefined;
      await vi.waitFor(async () => {
        const status = await tools.agent_status.execute(
          "queued-cancel-status",
          { runId: queuedRunId },
          undefined,
          undefined,
          context,
        );
        queuedStatus = parseToolText(status).run;
        expect(queuedStatus?.state?.kind).toBe("aborted");
      });
      expect(queuedStatus?.state?.result?.value?.termination).toBeUndefined();
      expect(spawn).toHaveBeenCalledTimes(4);
      expect(
        notifications.filter((notification) => notification.customType === "subagent-result"),
      ).toHaveLength(1);
      await tools.agent_cancel.execute(
        "cleanup-active-runs",
        { runId: runs[0].id },
        undefined,
        undefined,
        context,
      );
      await tools.agent_cancel.execute(
        "cleanup-active-runs-2",
        { runId: runs[1].id },
        undefined,
        undefined,
        context,
      );
      await tools.agent_cancel.execute(
        "cleanup-active-runs-3",
        { runId: runs[2].id },
        undefined,
        undefined,
        context,
      );
      await tools.agent_cancel.execute(
        "cleanup-active-runs-4",
        { runId: runs[3].id },
        undefined,
        undefined,
        context,
      );
    },
    20_000,
  );

  it.runIf(process.platform !== "win32")(
    "[process integration] shuts down active runs and queued work without late notifications",
    async () => {
      const project = createProject();
      vi.stubEnv("PI_CODING_AGENT_DIR", project);
      const fixturePath = path.join(project, "rpc-shutdown-child.cjs");
      const readyDirectory = path.join(project, "ready");
      const stoppedDirectory = path.join(project, "stopped");
      fs.mkdirSync(readyDirectory);
      fs.mkdirSync(stoppedDirectory);
      fs.writeFileSync(
        fixturePath,
        [
          'const fs = require("node:fs");',
          'let input = "";',
          'let taskId = "unknown";',
          'process.stdin.setEncoding("utf8");',
          'const write = (record) => process.stdout.write(JSON.stringify(record) + "\\n");',
          'process.on("SIGTERM", () => { fs.writeFileSync(`${process.env.SUBAGENT_FIXTURE_STOPPED_DIR}/${taskId}`, "stopped"); process.exit(0); });',
          'process.stdin.on("data", (chunk) => {',
          "  input += chunk;",
          '  while (input.includes("\\n")) {',
          '    const boundary = input.indexOf("\\n");',
          "    const command = JSON.parse(input.slice(0, boundary));",
          "    input = input.slice(boundary + 1);",
          '    if (command.type !== "prompt") continue;',
          "    const match = command.message.match(/queued-task-(\\d+)/);",
          '    taskId = match ? match[1] : "unknown";',
          '    write({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });',
          '    fs.writeFileSync(`${process.env.SUBAGENT_FIXTURE_READY_DIR}/${taskId}`, "ready");',
          '    write({ type: "agent_end", messages: [], willRetry: false });',
          "  }",
          "});",
        ].join("\n"),
      );
      vi.stubEnv("SUBAGENT_FIXTURE_READY_DIR", readyDirectory);
      vi.stubEnv("SUBAGENT_FIXTURE_STOPPED_DIR", stoppedDirectory);
      const { spawn: realSpawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      vi.mocked(spawn).mockImplementation((_command, _args, options) => {
        return realSpawn(process.execPath, [fixturePath], options) as never;
      });
      const events: Record<string, (...args: any[]) => unknown> = {};
      const notifications: Array<Record<string, any>> = [];
      const tools = registerSubagentTools(events, notifications);
      const sessionFile = path.join(project, "session.jsonl");
      const context = {
        cwd: project,
        hasUI: false,
        sessionManager: {
          getSessionFile: () => sessionFile,
          getSessionId: () => "shutdown-session",
        },
      };
      const launched = await tools.agent.execute(
        "async-shutdown",
        {
          async: true,
          agent: "worker",
          agentScope: "project",
          confirmProjectAgents: false,
          tasks: [1, 2, 3, 4, 5].map((number) => ({
            agent: "worker",
            task: `queued-task-${number}`,
          })),
        },
        undefined,
        undefined,
        context,
      );
      const runs = parseToolText(launched).runs;
      expect(runs).toHaveLength(5);
      await vi.waitFor(() => {
        for (let number = 1; number <= 4; number += 1) {
          expect(fs.existsSync(path.join(readyDirectory, String(number)))).toBe(true);
        }
      });
      expect(fs.existsSync(path.join(readyDirectory, "5"))).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(4);
      expect(typeof events.session_shutdown).toBe("function");

      await events.session_shutdown();
      await vi.waitFor(() => {
        for (let number = 1; number <= 4; number += 1) {
          expect(fs.existsSync(path.join(stoppedDirectory, String(number)))).toBe(true);
        }
      });
      expect(fs.existsSync(path.join(readyDirectory, "5"))).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(4);
      expect(
        notifications.some((notification) => notification.customType === "subagent-result"),
      ).toBe(false);
    },
    20_000,
  );

  it.runIf(process.platform !== "win32")(
    "[process integration] waits for retry settlement and accounts for usage across attempts once",
    async () => {
      const project = createProject();
      vi.stubEnv("PI_CODING_AGENT_DIR", project);
      const fixturePath = path.join(project, "rpc-retry-child.cjs");
      const firstAttemptPath = path.join(project, "first-attempt");
      const releasePath = path.join(project, "release-retry");
      fs.writeFileSync(
        fixturePath,
        [
          'const fs = require("node:fs");',
          'let input = "";',
          'const write = (record) => process.stdout.write(JSON.stringify(record) + "\\n");',
          'const message = (timestamp, text, input) => ({ role: "assistant", content: [{ type: "text", text }], api: "fixture", provider: "fixture", model: "fixture-model", stopReason: "stop", timestamp, usage: { input, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: input + 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });',
          'process.stdin.setEncoding("utf8");',
          'process.stdin.on("data", (chunk) => { input += chunk; while (input.includes("\\n")) { const boundary = input.indexOf("\\n"); const command = JSON.parse(input.slice(0, boundary)); input = input.slice(boundary + 1); if (command.type !== "prompt") continue; write({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } }); const first = message(1, "First model attempt failed and will retry.", 5); write({ type: "message_start", message: { ...first, content: [], stopReason: "pending" } }); write({ type: "message_end", message: first }); write({ type: "agent_end", messages: [first], willRetry: true }); fs.writeFileSync(process.env.SUBAGENT_RETRY_FIRST_ATTEMPT, "ready"); const wait = setInterval(() => { if (!fs.existsSync(process.env.SUBAGENT_RETRY_RELEASE)) return; clearInterval(wait); const second = message(2, "Fallback attempt completed.", 7); write({ type: "message_start", message: { ...second, content: [], stopReason: "pending" } }); write({ type: "message_end", message: second }); write({ type: "agent_end", messages: [second], willRetry: false }); write({ type: "agent_settled", aborted: false }); setTimeout(() => process.exit(0), 10); }, 10); } });',
        ].join("\n"),
      );
      vi.stubEnv("SUBAGENT_RETRY_FIRST_ATTEMPT", firstAttemptPath);
      vi.stubEnv("SUBAGENT_RETRY_RELEASE", releasePath);
      const { spawn: realSpawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      vi.mocked(spawn).mockImplementation(
        (_command, _args, options) => realSpawn(process.execPath, [fixturePath], options) as never,
      );
      const notifications: Array<Record<string, any>> = [];
      const tools = registerSubagentTools({}, notifications);
      const sessionFile = path.join(project, "retry-session.jsonl");
      const context = {
        cwd: project,
        hasUI: false,
        sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "retry-session" },
      };
      const launched = await tools.agent.execute(
        "async-retry",
        {
          async: true,
          agent: "worker",
          task: "Retry then fall back",
          agentScope: "project",
          confirmProjectAgents: false,
        },
        undefined,
        undefined,
        context,
      );
      const runId = parseToolText(launched).runs?.[0]?.id;
      expect(typeof runId).toBe("string");
      await vi.waitFor(() => expect(fs.existsSync(firstAttemptPath)).toBe(true));
      expect(
        notifications.filter((message) => message.customType === "subagent-result"),
      ).toHaveLength(0);
      const statusTool = () =>
        tools.agent_status.execute("retry-status", { runId }, undefined, undefined, context);
      expect(parseToolText(await statusTool()).run?.state?.kind).toBe("running");

      fs.writeFileSync(releasePath, "continue");
      await vi.waitFor(async () =>
        expect(parseToolText(await statusTool()).run?.state?.kind).toBe("completed"),
      );
      const terminal = notifications.filter((message) => message.customType === "subagent-result");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.details).toMatchObject({
        agentScope: "project",
        projectAgentsDir: path.join(project, ".pi", "agents"),
      });
      expect(terminal[0]?.details.results[0]?.usage).toMatchObject({
        input: 12,
        output: 4,
        turns: 2,
      });
    },
    20_000,
  );

  it.runIf(process.platform !== "win32")(
    "[process integration] switches sessions by stopping active and queued runs without new-session notifications",
    async () => {
      const project = createProject();
      vi.stubEnv("PI_CODING_AGENT_DIR", project);
      const fixturePath = path.join(project, "rpc-session-switch-child.cjs");
      const readyDirectory = path.join(project, "switch-ready");
      const stoppedDirectory = path.join(project, "switch-stopped");
      fs.mkdirSync(readyDirectory);
      fs.mkdirSync(stoppedDirectory);
      fs.writeFileSync(
        fixturePath,
        [
          'const fs = require("node:fs");',
          'let input = ""; let task = "unknown";',
          'process.stdin.setEncoding("utf8");',
          'process.on("SIGTERM", () => { fs.writeFileSync(`${process.env.SUBAGENT_SWITCH_STOPPED}/${task}`, "stopped"); process.exit(0); });',
          'process.stdin.on("data", (chunk) => { input += chunk; while (input.includes("\\n")) { const boundary = input.indexOf("\\n"); const command = JSON.parse(input.slice(0, boundary)); input = input.slice(boundary + 1); if (command.type !== "prompt") continue; task = command.message.match(/session-switch-(\\d+)/)?.[1] ?? "unknown"; process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } }) + "\\n"); fs.writeFileSync(`${process.env.SUBAGENT_SWITCH_READY}/${task}`, "ready"); } });',
        ].join("\n"),
      );
      vi.stubEnv("SUBAGENT_SWITCH_READY", readyDirectory);
      vi.stubEnv("SUBAGENT_SWITCH_STOPPED", stoppedDirectory);
      const { spawn: realSpawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      vi.mocked(spawn).mockImplementation(
        (_command, _args, options) => realSpawn(process.execPath, [fixturePath], options) as never,
      );
      const events: Record<string, (...args: any[]) => unknown> = {};
      const notifications: Array<Record<string, any>> = [];
      const tools = registerSubagentTools(events, notifications);
      const sessionFile = path.join(project, "old-session.jsonl");
      const firstContext = {
        cwd: project,
        hasUI: false,
        sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "old-session" },
      };
      const launched = await tools.agent.execute(
        "async-session-switch",
        {
          async: true,
          tasks: [1, 2, 3, 4, 5].map((number) => ({
            agent: "worker",
            task: `session-switch-${number}`,
          })),
          agentScope: "project",
          confirmProjectAgents: false,
        },
        undefined,
        undefined,
        firstContext,
      );
      const runs = parseToolText(launched).runs;
      await vi.waitFor(() => {
        for (let number = 1; number <= 4; number += 1)
          expect(fs.existsSync(path.join(readyDirectory, String(number)))).toBe(true);
      });
      expect(fs.existsSync(path.join(readyDirectory, "5"))).toBe(false);
      const newContext = {
        cwd: project,
        hasUI: false,
        sessionManager: {
          getSessionFile: () => path.join(project, "new-session.jsonl"),
          getSessionId: () => "new-session",
        },
      };
      await events.session_start({ reason: "resume" }, newContext);
      await vi.waitFor(() => {
        for (let number = 1; number <= 4; number += 1)
          expect(fs.existsSync(path.join(stoppedDirectory, String(number)))).toBe(true);
      });
      expect(spawn).toHaveBeenCalledTimes(4);
      expect(notifications).toHaveLength(0);
      expect(runs).toHaveLength(5);
      const newSessionStatus = await tools.agent_status.execute(
        "new-session-list",
        {},
        undefined,
        undefined,
        newContext,
      );
      expect(parseToolText(newSessionStatus).runs).toEqual([]);
    },
    20_000,
  );

  it.runIf(process.platform !== "win32")(
    "[process integration] reports an async artifact write failure without announcing a path",
    async () => {
      const project = createProject();
      vi.stubEnv("PI_CODING_AGENT_DIR", project);
      const toolCallId = "async-artifact-write-failure";
      const sessionFile = path.join(project, "session.jsonl");
      const outputPath = buildArtifactPath({
        sessionFile,
        toolCallId,
        mode: "single",
        agent: "worker",
      });
      const fixturePath = path.join(project, "rpc-artifact-failure-child.cjs");
      const readyPath = path.join(project, "artifact-failure-ready");
      const releasePath = path.join(project, "artifact-failure-release");
      fs.writeFileSync(
        fixturePath,
        [
          'const fs = require("node:fs");',
          'let input = "";',
          'const write = (record) => process.stdout.write(JSON.stringify(record) + "\\n");',
          'process.stdin.setEncoding("utf8");',
          'process.stdin.on("data", (chunk) => {',
          "  input += chunk;",
          '  while (input.includes("\\n")) {',
          '    const boundary = input.indexOf("\\n");',
          "    const command = JSON.parse(input.slice(0, boundary));",
          "    input = input.slice(boundary + 1);",
          '    if (command.type !== "prompt") continue;',
          '    write({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } });',
          '    fs.writeFileSync(process.env.SUBAGENT_ARTIFACT_FAILURE_READY, "ready");',
          "    const wait = setInterval(() => {",
          "      if (!fs.existsSync(process.env.SUBAGENT_ARTIFACT_FAILURE_RELEASE)) return;",
          "      clearInterval(wait);",
          '      write({ type: "agent_end", messages: [], willRetry: false });',
          '      write({ type: "agent_settled", aborted: false });',
          "      setTimeout(() => process.exit(0), 10);",
          "    }, 10);",
          "  }",
          "});",
        ].join("\n"),
      );
      vi.stubEnv("SUBAGENT_ARTIFACT_FAILURE_READY", readyPath);
      vi.stubEnv("SUBAGENT_ARTIFACT_FAILURE_RELEASE", releasePath);
      const { spawn: realSpawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      vi.mocked(spawn).mockImplementation(
        (_command, _args, options) => realSpawn(process.execPath, [fixturePath], options) as never,
      );
      const notifications: Array<Record<string, any>> = [];
      const tools = registerSubagentTools({}, notifications);
      const context = {
        cwd: project,
        hasUI: false,
        sessionManager: {
          getSessionFile: () => sessionFile,
          getSessionId: () => "artifact-failure",
        },
      };
      const launched = await tools.agent.execute(
        toolCallId,
        {
          async: true,
          agent: "worker",
          task: "Complete after the parent creates an artifact-path blocker",
          agentScope: "project",
          confirmProjectAgents: false,
        },
        undefined,
        undefined,
        context,
      );
      const runId = parseToolText(launched).runs?.[0]?.id;
      expect(typeof runId).toBe("string");
      await vi.waitFor(() => expect(fs.existsSync(readyPath)).toBe(true));

      const statusTool = () =>
        tools.agent_status.execute(
          "artifact-failure-status",
          { runId },
          undefined,
          undefined,
          context,
        );
      expect(parseToolText(await statusTool()).run?.state?.kind).toBe("running");
      fs.mkdirSync(outputPath, { recursive: true });
      fs.writeFileSync(releasePath, "release");
      await vi.waitFor(async () =>
        expect(parseToolText(await statusTool()).run?.state?.kind).toBe("failed"),
      );

      const status = parseToolText(await statusTool()).run;
      expect(status?.state?.error).toContain("Unable to write subagent artifact");
      expect(JSON.stringify(status)).not.toContain("artifactPath");
      expect(fs.statSync(outputPath).isDirectory()).toBe(true);
      const terminal = notifications.filter((message) => message.customType === "subagent-result");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.content).not.toContain(outputPath);
      expect(JSON.stringify(terminal[0]?.details)).not.toContain(outputPath);
    },
    10_000,
  );

  it.runIf(process.platform !== "win32")(
    "[process integration] Pi RPC delivers steering and settles after an explicit parent report",
    async () => {
      const project = createProject();
      const providerPath = path.join(project, "fixture-provider.mjs");
      const providerReadyPath = path.join(project, "provider-ready");
      const providerReleasePath = path.join(project, "provider-release");
      const testFilePath = fileURLToPath(import.meta.url);
      const repositoryRoot = path.resolve(path.dirname(testFilePath), "../..");
      const reportExtensionPath = path.join(repositoryRoot, "extensions/subagent/report.ts");
      const aiModulePath = pathToFileURL(
        path.resolve(repositoryRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"),
      ).href;
      fs.writeFileSync(
        providerPath,
        `import * as fs from "node:fs";\n` +
          `import { createAssistantMessageEventStream } from ${JSON.stringify(aiModulePath)};\n` +
          `let calls = 0;\n` +
          `function userText(messages) { return messages.filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ") : "").join("\\n"); }\n` +
          `export default function (pi) {\n` +
          `  pi.registerProvider("fixture", {\n` +
          `    api: "openai-completions",\n` +
          `    baseUrl: "http://127.0.0.1/unused",\n` +
          `    apiKey: "fixture",\n` +
          `    models: [{ id: "fixture-model", name: "Fixture Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 512 }],\n` +
          `    streamSimple(model, context) {\n` +
          `      const stream = createAssistantMessageEventStream();\n` +
          `      void (async () => {\n` +
          `        calls += 1;\n` +
          `        let content;\n` +
          `        let stopReason;\n` +
          `        if (calls === 1) {\n` +
          `          fs.writeFileSync(process.env.SUBAGENT_FIXTURE_PROVIDER_READY, "ready");\n` +
          `          while (!fs.existsSync(process.env.SUBAGENT_FIXTURE_PROVIDER_RELEASE)) await new Promise((resolve) => setTimeout(resolve, 10));\n` +
          `          content = [{ type: "toolCall", id: "report-call-1", name: "report_to_parent", arguments: { message: "Child reached the parent report checkpoint." } }];\n` +
          `          stopReason = "toolUse";\n` +
          `        } else {\n` +
          `          content = [{ type: "text", text: "Steering received: " + userText(context.messages) }];\n` +
          `          stopReason = "stop";\n` +
          `        }\n` +
          `        const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() };\n` +
          `        stream.push({ type: "start", partial: message });\n` +
          `        stream.push({ type: "done", reason: stopReason, message });\n` +
          `        stream.end();\n` +
          `      })().catch((error) => { stream.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: String(error), timestamp: Date.now() } }); stream.end(); });\n` +
          `      return stream;\n` +
          `    },\n` +
          `  });\n` +
          `}\n`,
      );
      const reportPromise = new Promise<{ runId: string; message: string }>((resolve) => {
        void createReportServer({
          runId: "pi-runtime-run",
          onReport(report) {
            resolve({ runId: report.runId, message: report.message });
            return { accepted: true };
          },
        }).then((server) => {
          reportServer = server;
        });
      });
      let reportServer: Awaited<ReturnType<typeof createReportServer>> | undefined;
      await vi.waitFor(() => expect(reportServer).toBeDefined());
      const cliPath = path.join(getPackageDir(), "dist", "cli.js");
      const { spawn: realSpawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const child = realSpawn(
        process.execPath,
        [
          cliPath,
          "--mode",
          "rpc",
          "--no-session",
          "--extension",
          providerPath,
          "--extension",
          reportExtensionPath,
          "--model",
          "fixture/fixture-model",
        ],
        {
          cwd: project,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: project,
            PI_CODING_AGENT_SESSION_DIR: path.join(project, "sessions"),
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
            SUBAGENT_FIXTURE_PROVIDER_READY: providerReadyPath,
            SUBAGENT_FIXTURE_PROVIDER_RELEASE: providerReleasePath,
            ...reportServer?.environment,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const records: Array<Record<string, any>> = [];
      let buffered = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffered += chunk;
        while (buffered.includes("\n")) {
          const boundary = buffered.indexOf("\n");
          const line = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 1);
          if (line) records.push(JSON.parse(line));
        }
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      const waitForRecord = async (predicate: (record: Record<string, any>) => boolean) => {
        await vi.waitFor(
          () => {
            expect(records.some(predicate), stderr).toBe(true);
          },
          { timeout: 15_000 },
        );
        return records.find(predicate);
      };

      try {
        child.stdin.write(
          `${JSON.stringify({ id: "prompt-1", type: "prompt", message: "Start and report." })}\n`,
        );
        await vi.waitFor(() => expect(fs.existsSync(providerReadyPath)).toBe(true), {
          timeout: 15_000,
        });
        child.stdin.write(
          `${JSON.stringify({ id: "steer-1", type: "steer", message: "Use the marker code green." })}\n`,
        );
        await waitForRecord((record) => record.type === "response" && record.id === "steer-1");
        fs.writeFileSync(providerReleasePath, "release");

        const report = await reportPromise;
        expect(report).toEqual({
          runId: "pi-runtime-run",
          message: "Child reached the parent report checkpoint.",
        });
        await waitForRecord((record) => record.type === "agent_settled");
        const finalText = records
          .filter((record) => record.type === "message_end" && record.message?.role === "assistant")
          .flatMap((record) => record.message.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        expect(finalText).toContain("Use the marker code green.");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once("close", () => resolve());
        });
        await reportServer?.close();
      }
    },
    25_000,
  );
});
