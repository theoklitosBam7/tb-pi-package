import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPackageDir, initTheme } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, realSpawn: actual.spawn, spawn: vi.fn() };
});

import { ChildProcess, spawn, spawnSync } from "node:child_process";
import * as childProcess from "node:child_process";
const realSpawn = (childProcess as typeof childProcess & { realSpawn: typeof spawn }).realSpawn;
import subagentExtension, { buildSubagentArgs } from "./index.js";
import {
  buildArtifactPath,
  formatChainSummary,
  formatParallelSummary,
  formatSingleSummary,
  getFinalOutput,
  getResultOutput,
  getResultStatus,
  installAbortHandler,
  isCompletedResult,
  type ResultThinking,
  type SingleResult,
  writeResultArtifact,
} from "./result.js";

initTheme();

// Minimal message fixtures. getFinalOutput only reads role and content
// part type/text, so these carry just what the behavior depends on.
const assistant = (text: string): Message =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as Message;
const assistantToolCallOnly = (): Message =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }],
  }) as Message;
const user = (text: string): Message => ({ role: "user", content: text }) as Message;
const toolResult = (): Message =>
  ({ role: "toolResult", content: [{ type: "text", text: "result" }] }) as Message;

describe("buildArtifactPath", () => {
  it("places a sanitized parallel-task file under the session-specific directory", () => {
    expect(
      buildArtifactPath({
        sessionFile: "/home/user/.pi/agent/sessions/--project--/2026-01-02_session.jsonl",
        toolCallId: "call-123",
        mode: "parallel",
        index: 2,
        agent: "reviewer/security",
      }),
    ).toBe(
      "/home/user/.pi/agent/sessions/--project--/2026-01-02_session/call-123-parallel-02-reviewer_security.md",
    );
  });
});

describe("buildSubagentArgs", () => {
  it("passes the selected model, thinking level, tools, and prompt file to Pi", () => {
    expect(
      buildSubagentArgs({
        model: "openai/gpt-5",
        thinking: "medium",
        tools: ["read", "rg"],
        promptPath: "/tmp/reviewer-prompt.md",
        task: "Review the change",
      }),
    ).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--model",
      "openai/gpt-5",
      "--thinking",
      "medium",
      "--tools",
      "read,rg",
      "--append-system-prompt",
      "/tmp/reviewer-prompt.md",
      "Task: Review the change",
    ]);
  });
});

describe("getFinalOutput", () => {
  it("returns the text of the last assistant message, ignoring earlier ones and user messages", () => {
    const messages = [user("hi"), assistant("first"), assistant("second")];
    expect(getFinalOutput(messages)).toBe("second");
  });

  it("returns an empty string when there is no assistant message", () => {
    expect(getFinalOutput([user("hi"), toolResult()])).toBe("");
  });

  it("returns an empty string for an empty message list", () => {
    expect(getFinalOutput([])).toBe("");
  });

  it("joins every text part in the final assistant message", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "first block" },
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "second block" },
      ],
    } as Message;

    expect(getFinalOutput([message])).toBe("first block\n\nsecond block");
  });

  it("skips an assistant message that has only tool-call parts and returns the previous text", () => {
    // The real call site depends on this extraction. An assistant turn that
    // ends in a tool call (no trailing text) must not shadow an earlier
    // text-bearing assistant message.
    const messages = [assistant("real-output"), assistantToolCallOnly()];
    expect(getFinalOutput(messages)).toBe("real-output");
  });
});

describe("artifact summaries", () => {
  it("returns a completion status and read instruction for a single task", () => {
    expect(formatSingleSummary({ exitCode: 0 }, "/sessions/run/result.md")).toBe(
      "Agent completed. Read this file before continuing: /sessions/run/result.md",
    );
  });

  it("returns every chain path and marks the last produced artifact as final", () => {
    expect(
      formatChainSummary([
        { outputPath: "/sessions/run/step-1.md", exitCode: 0 },
        { outputPath: "/sessions/run/step-2.md", exitCode: 1 },
      ]),
    ).toBe(
      "Step 1 completed. Read this file before continuing: /sessions/run/step-1.md\n" +
        "Step 2 failed (final). Read this file before continuing: /sessions/run/step-2.md",
    );
  });

  it("reports cleanup uncertainty in each summary only when recorded", () => {
    const result = {
      exitCode: 1,
      stopReason: "aborted",
      termination: { kind: "abort", cleanup: "unknown" },
    } as const;
    expect(formatSingleSummary(result, "/result.md")).toContain("Cleanup: unknown.");
    expect(formatChainSummary([{ ...result, outputPath: "/result.md" }])).toContain(
      "Cleanup: unknown.",
    );
    expect(
      formatParallelSummary([{ ...result, agent: "worker", outputPath: "/result.md" }]),
    ).toContain("Cleanup: unknown.");
    expect(formatSingleSummary({ exitCode: 1, stopReason: "aborted" }, "/old.md")).not.toContain(
      "Cleanup:",
    );
  });

  it("labels a user-aborted result as aborted in summaries", () => {
    const result = { exitCode: 1, stopReason: "aborted" } as const;

    expect(formatSingleSummary(result, "/sessions/run/result.md")).toContain("Agent aborted.");
    expect(formatChainSummary([{ ...result, outputPath: "/sessions/run/step-1.md" }])).toContain(
      "Step 1 aborted (final).",
    );
    expect(
      formatParallelSummary([
        { ...result, agent: "worker", outputPath: "/sessions/run/worker.md" },
      ]),
    ).toContain("[worker] aborted.");
  });
});

describe("formatParallelSummary", () => {
  it("returns per-task read instructions without embedding subagent output", () => {
    const text = formatParallelSummary([
      { agent: "alpha", exitCode: 0, outputPath: "/sessions/run/alpha.md" },
      {
        agent: "beta",
        exitCode: 0,
        stopReason: "error",
        outputPath: "/sessions/run/beta.md",
      },
    ]);

    expect(text).toContain("Parallel: 1/2 succeeded");
    expect(text).toContain(
      "[alpha] completed. Read this file before continuing: /sessions/run/alpha.md",
    );
    expect(text).toContain(
      "[beta] failed. Read this file before continuing: /sessions/run/beta.md",
    );
  });

  it("does not throw on an empty results array", () => {
    expect(formatParallelSummary([])).toContain("Parallel: 0/0 succeeded");
  });
});

describe("getResultStatus", () => {
  it("keeps an in-flight result running until process completion", () => {
    expect(getResultStatus({ exitCode: -1 })).toBe("running");
  });

  it("classifies error and aborted stop reasons as failures even with exit code zero", () => {
    expect(getResultStatus({ exitCode: 0, stopReason: "error" })).toBe("failed");
    expect(getResultStatus({ exitCode: 0, stopReason: "aborted" })).toBe("failed");
  });

  it("classifies a clean zero exit as completed", () => {
    expect(getResultStatus({ exitCode: 0 })).toBe("completed");
  });
});

describe("model fallback decision", () => {
  it("does not accept a zero-exit error result as completed", () => {
    expect(isCompletedResult({ exitCode: 0, stopReason: "error" })).toBe(false);
    expect(isCompletedResult({ exitCode: 0, stopReason: "aborted" })).toBe(false);
    expect(isCompletedResult({ exitCode: 0 })).toBe(true);
  });
});

describe("writeResultArtifact", () => {
  it("persists completed metadata and full output without failure sections", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-artifact-test-"));
    const outputPath = path.join(dir, "completed.md");
    const result: SingleResult = {
      agent: "reviewer",
      agentSource: "user",
      task: "Review",
      exitCode: 0,
      messages: [assistant("# Finding\n\nComplete output.")],
      stderr: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      model: "anthropic/claude-sonnet-4-5",
      thinking: "medium",
      thinkingKind: "configured",
    };
    const acceptSingleResult = (value: SingleResult) => value;
    const acceptResultThinking = (value: ResultThinking) => value;
    acceptResultThinking({ thinkingKind: "not-run", thinking: undefined });
    // @ts-expect-error A result cannot have both a thinking level and a not-run state.
    acceptSingleResult({ ...result, thinking: "high", thinkingKind: "not-run" });
    acceptSingleResult({
      agent: "reviewer",
      agentSource: "user",
      task: "Review",
      exitCode: 0,
      messages: [],
      stderr: "",
      usage: result.usage,
      thinkingKind: "not-run",
      thinking: undefined,
    });
    // @ts-expect-error Every result must declare its thinking state.
    const untaggedResult: SingleResult = {
      agent: "reviewer",
      agentSource: "user",
      task: "Review",
      exitCode: 0,
      messages: [],
      stderr: "",
      usage: result.usage,
    };
    void untaggedResult;

    try {
      await writeResultArtifact({
        result,
        outputPath,
        taskLabel: "parallel item 2",
        startedAt: "2026-01-02T03:04:05.000Z",
      });

      const artifact = fs.readFileSync(outputPath, "utf8");
      expect(artifact).toContain("- Status: completed");
      expect(artifact).toContain("- Model: anthropic/claude-sonnet-4-5");
      expect(artifact).toContain("- Thinking: medium");
      expect(artifact).toContain("- Task: parallel item 2");
      expect(artifact).toContain("## Result\n\n# Finding\n\nComplete output.");
      expect(artifact).not.toContain("## Failure diagnostics");
      expect(result.messages).toEqual([]);
      expect(result.displayItems).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists an aborted result privately and removes response messages from details", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-artifact-test-"));
    const outputPath = path.join(dir, "aborted.md");
    const result: SingleResult = {
      agent: "reviewer",
      agentSource: "user",
      task: "Review",
      exitCode: 1,
      messages: [assistant("partial response")],
      stderr: "child stderr diagnostic",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      thinkingKind: "default",
      stopReason: "aborted",
      errorMessage: "Agent was aborted",
    };

    try {
      await writeResultArtifact({
        result,
        outputPath,
        taskLabel: "single task",
        startedAt: "2026-01-02T03:04:05.000Z",
      });

      const artifact = fs.readFileSync(outputPath, "utf8");
      expect(artifact).toContain("- Status: aborted");
      expect(artifact).toContain("- Thinking: Pi default");
      expect(artifact).toContain("- Stop reason: aborted");
      expect(artifact).toContain("## Result\n\npartial response");
      expect(artifact).toContain(
        "## Failure diagnostics\n\n### Error message\n\nAgent was aborted\n\n### Stderr\n\nchild stderr diagnostic",
      );
      expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(dir)).toEqual(["aborted.md"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits an absent error message section from failed artifacts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-artifact-test-"));
    const outputPath = path.join(dir, "stderr-only.md");
    const result: SingleResult = {
      agent: "reviewer",
      agentSource: "user",
      task: "Review",
      exitCode: 1,
      messages: [assistant("partial response")],
      stderr: "child stderr diagnostic",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      thinkingKind: "default",
    };

    try {
      await writeResultArtifact({
        result,
        outputPath,
        taskLabel: "single task",
        startedAt: "2026-01-02T03:04:05.000Z",
      });

      const artifact = fs.readFileSync(outputPath, "utf8");
      expect(artifact).toContain("### Stderr\n\nchild stderr diagnostic");
      expect(artifact).not.toContain("### Error message");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans a temp artifact and preserves messages when rename fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-artifact-test-"));
    const outputPath = path.join(dir, "result.md");
    fs.mkdirSync(outputPath);
    const result: SingleResult = {
      agent: "reviewer",
      agentSource: "user",
      task: "Review",
      exitCode: 0,
      messages: [assistant("done")],
      stderr: "",
      thinkingKind: "default",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
    };

    try {
      await expect(
        writeResultArtifact({
          result,
          outputPath,
          taskLabel: "single task",
          startedAt: "2026-01-02T03:04:05.000Z",
        }),
      ).rejects.toThrow();
      expect(result.messages).toEqual([assistant("done")]);
      expect(fs.readdirSync(dir)).toEqual(["result.md"]);
      expect(fs.readdirSync(outputPath)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("artifact-backed rendering", () => {
  it("retains lightweight tool calls after messages are cleared", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-render-test-"));
    const outputPath = path.join(dir, "result.md");
    const result: SingleResult = {
      agent: "reviewer",
      agentSource: "user",
      task: "Review",
      exitCode: 0,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "1", name: "read", arguments: { path: "/tmp/input.ts" } },
            { type: "text", text: "done" },
          ],
        } as Message,
      ],
      stderr: "",
      thinkingKind: "default",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
    };

    try {
      await writeResultArtifact({
        result,
        outputPath,
        taskLabel: "single task",
        startedAt: "2026-01-02T03:04:05.000Z",
      });

      expect(result.messages).toEqual([]);
      expect(result.displayItems).toEqual([
        { type: "toolCall", name: "read", args: { path: "/tmp/input.ts" } },
      ]);

      const tools: Record<string, any> = {};
      subagentExtension({
        on() {},
        registerTool(tool: any) {
          tools[tool.name] = tool;
        },
        registerCommand() {},
        registerShortcut() {},
      } as any);
      const theme = {
        bold: (text: string) => text,
        fg: (_color: string, text: string) => text,
      };
      const rendered = tools.agent
        .renderResult(
          {
            content: [{ type: "text", text: "Agent completed." }],
            details: {
              mode: "single",
              agentScope: "user",
              projectAgentsDir: null,
              results: [result],
            },
          },
          { expanded: true, isPartial: false },
          theme,
          {},
        )
        .render(100)
        .join("\n");

      expect(rendered).toContain("read /tmp/input.ts");
      expect(rendered).toContain("done");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("getResultOutput", () => {
  it("renders messages from legacy results that have no artifact path", () => {
    expect(getResultOutput({ messages: [assistant("legacy output")] })).toBe("legacy output");
  });

  it("reads artifact-backed results when expanded", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-result-test-"));
    const outputPath = path.join(dir, "result.md");
    fs.writeFileSync(outputPath, "artifact output", { mode: 0o600 });
    try {
      expect(getResultOutput({ messages: [], outputPath })).toBe("artifact output");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back clearly when an artifact is missing", () => {
    expect(getResultOutput({ messages: [], outputPath: "/missing/result.md" })).toBe(
      "Artifact unavailable: /missing/result.md",
    );
  });
});

describe("subagent rendering", () => {
  it("includes descendant usage once in aggregate rendering", () => {
    const tools: Record<string, any> = {};
    subagentExtension({
      on() {},
      registerTool(tool: any) {
        tools[tool.name] = tool;
      },
      registerCommand() {},
      registerShortcut() {},
    } as any);
    const theme = {
      bold: (text: string) => text,
      fg: (_color: string, text: string) => text,
    };
    const rendered = tools.agent
      .renderResult(
        {
          content: [{ type: "text", text: "Parallel: 1/1 tasks" }],
          details: {
            usageVersion: 2,
            mode: "parallel",
            agentScope: "user",
            projectAgentsDir: null,
            results: [
              {
                agent: "worker",
                agentSource: "user",
                task: "task",
                exitCode: 0,
                messages: [],
                stderr: "",
                usage: {
                  input: 10,
                  output: 2,
                  cacheRead: 1,
                  cacheWrite: 0,
                  cost: 0.1,
                  contextTokens: 12,
                  turns: 1,
                },
                descendantUsage: {
                  input: 4,
                  output: 3,
                  cacheRead: 2,
                  cacheWrite: 1,
                  cost: 0.2,
                },
              },
            ],
          },
        },
        { expanded: false, isPartial: false },
        theme,
        {},
      )
      .render(120)
      .join("\n");

    expect(rendered).toContain("Total: 1 turn ↑14 ↓5 R3 W1 $0.3000");
  });

  it("uses status classification for concurrent results and keeps partial renders status-only", () => {
    const tools: Record<string, any> = {};
    subagentExtension({
      on() {},
      registerTool(tool: any) {
        tools[tool.name] = tool;
      },
      registerCommand() {},
      registerShortcut() {},
    } as any);
    const theme = {
      bold: (text: string) => text,
      fg: (_color: string, text: string) => text,
    };
    const result = {
      content: [{ type: "text", text: "Parallel: 1/2 done, 1 running..." }],
      details: {
        mode: "parallel",
        results: [
          {
            agent: "completed-with-error-stop",
            agentSource: "user",
            task: "first",
            exitCode: 0,
            stopReason: "error",
            messages: [],
            stderr: "",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          },
          {
            agent: "still-running",
            agentSource: "user",
            task: "second",
            exitCode: -1,
            messages: [],
            stderr: "",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          },
        ],
      },
    };

    const partial = tools.agent
      .renderResult(result, { expanded: true, isPartial: true }, theme, {})
      .render(80)
      .join("\n");
    const rendered = tools.agent
      .renderResult(result, { expanded: false, isPartial: false }, theme, {})
      .render(80)
      .join("\n");

    expect(partial.trimEnd()).toBe("Parallel: 1/2 done, 1 running...");
    expect(rendered).toContain("1/2 done, 1 running");
    expect(rendered).toContain("completed-with-error-stop ✗");
    expect(rendered).toContain("still-running ⏳");
  });
});

function createPersistenceTestProject(prefix: string, agentDefinition: string): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `subagent-${prefix}`));
  vi.stubEnv("PI_CODING_AGENT_DIR", project);
  const agentsDir = path.join(project, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "worker.md"), agentDefinition);
  return project;
}

function createPersistenceTestChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
}

function emitPersistenceTestMessage(
  child: ReturnType<typeof createPersistenceTestChild>,
  message: object,
): void {
  const startMessage =
    "role" in message && message.role === "assistant"
      ? { ...message, content: [], stopReason: "pending" }
      : message;
  child.stdout.emit(
    "data",
    `${JSON.stringify({ type: "message_start", message: startMessage })}\n`,
  );
  child.stdout.emit("data", `${JSON.stringify({ type: "message_end", message })}\n`);
}

function registerPersistenceTestTools(
  thinkingLevel?: "off" | "xhigh",
  events: Record<string, () => void> = {},
): Record<string, any> {
  const tools: Record<string, any> = {};
  subagentExtension({
    getThinkingLevel: () => thinkingLevel,
    on(event: string, handler: () => void) {
      events[event] = handler;
    },
    registerTool(tool: any) {
      tools[tool.name] = tool;
    },
    registerCommand() {},
    registerShortcut() {},
  } as any);
  return tools;
}

describe("subagent output limits", () => {
  it.each([
    { chunks: ["No API key"], attempts: 2 },
    { chunks: ["No AP", "I key"], attempts: 2 },
    { chunks: ["model", "x".repeat(70_000), "not avail", "able"], attempts: 2 },
    { chunks: ["provider", "x".repeat(70_000), "er", "ror"], attempts: 2 },
    { chunks: ["model", "x".repeat(70_000), "error"], attempts: 1 },
    { chunks: ["provider", "x".repeat(70_000), "not found"], attempts: 1 },
  ])(
    "matches late stderr terms across chunks: $chunks",
    async ({ chunks, attempts: expectedAttempts }) => {
      const project = createPersistenceTestProject(
        "late-fallback-",
        "---\nname: worker\ndescription: Test worker\nmodel: test/fallback\n---\n",
      );
      let attempts = 0;
      vi.mocked(spawn).mockImplementation(() => {
        const child = createPersistenceTestChild();
        attempts++;
        queueMicrotask(() => {
          if (attempts === 1) {
            child.stderr.emit("data", "x".repeat(70_000));
            for (const chunk of chunks) child.stderr.emit("data", chunk);
            child.emit("close", 1, null);
          } else {
            child.emit("close", 0, null);
          }
        });
        return child as never;
      });
      try {
        await registerPersistenceTestTools().agent.execute(
          "late-fallback",
          {
            agent: "worker",
            task: "test",
            model: "test/primary",
            agentScope: "project",
            confirmProjectAgents: false,
          },
          undefined,
          undefined,
          {
            cwd: project,
            hasUI: false,
            sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
          },
        );
        expect(attempts).toBe(expectedAttempts);
      } finally {
        vi.mocked(spawn).mockReset();
        vi.unstubAllEnvs();
        fs.rmSync(project, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])("bounds noisy stderr and hides it on timeout: %s", async (timeout) => {
    vi.useFakeTimers();
    const project = createPersistenceTestProject(
      "stderr-limit-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    try {
      const execution = registerPersistenceTestTools().agent.execute(
        "stderr-limit",
        {
          agent: "worker",
          task: "test",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      child.stderr.emit("data", "secret-diagnostic " + "x".repeat(1024 * 1024));
      child.stderr.emit("data", "y".repeat(1024 * 1024));
      if (timeout) await vi.advanceTimersByTimeAsync(1_000);
      else child.emit("close", 1, null);
      const result = await execution;
      const stderr = result.details.results[0].stderr;
      expect(stderr.length).toBeLessThan(100_000);
      if (timeout) expect(JSON.stringify(result)).not.toContain("secret-diagnostic");
      else {
        expect(stderr).toContain("secret-diagnostic");
        expect(stderr).toContain("[stderr truncated]");
      }
    } finally {
      vi.useRealTimers();
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("discards an oversized stdout line and recovers at the next JSONL event", async () => {
    const project = createPersistenceTestProject(
      "stdout-limit-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", "x".repeat(1024 * 1024));
        child.stdout.emit("data", "x".repeat(1024 * 1024));
        child.stdout.emit("data", "end\n");
        const message = {
          role: "assistant",
          content: [{ type: "text", text: "recovered 😀" }],
          stopReason: "stop",
          timestamp: 1,
          api: "test",
          provider: "test",
          model: "test",
        };
        const events = Buffer.from(
          `${JSON.stringify({ type: "message_start", message })}\n${JSON.stringify({ type: "message_end", message })}\n`,
        );
        const split = events.indexOf(Buffer.from("😀")) + 1;
        child.stdout.emit("data", events.subarray(0, split));
        child.stdout.emit("data", events.subarray(split));
        child.emit("close", 0, null);
      });
      return child as never;
    });
    try {
      const result = await registerPersistenceTestTools().agent.execute(
        "stdout-limit",
        { agent: "worker", task: "test", agentScope: "project", confirmProjectAgents: false },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );
      expect(result.details.results[0].usage.turns).toBe(1);
      expect(fs.readFileSync(result.details.results[0].outputPath, "utf8")).toContain(
        "recovered 😀",
      );
      expect(result.details.results[0].stderr).toContain("[stdout line truncated]");
    } finally {
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("subagent watchdog", () => {
  it("uses task precedence when task, tool, and idle deadlines expire together", async () => {
    vi.useFakeTimers();
    const project = createPersistenceTestProject(
      "watchdog-simultaneous-deadlines-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();

    try {
      const execution = tools.agent.execute(
        "call-watchdog-simultaneous-deadlines",
        {
          agent: "worker",
          task: "Expire all three deadlines together",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: 1, toolSeconds: 1, taskSeconds: 1 },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      child.stdout.emit(
        "data",
        `${JSON.stringify({ type: "tool_execution_start", toolCallId: "same-time", toolName: "read" })}\n`,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(6_000);
      const result = await execution;

      expect(result.details.results[0].termination).toMatchObject({
        kind: "watchdog",
        deadline: "task",
        activeTool: "read",
      });
    } finally {
      vi.useRealTimers();
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("uses tool precedence when tool and idle deadlines expire together", async () => {
    vi.useFakeTimers();
    const project = createPersistenceTestProject(
      "watchdog-tool-idle-deadlines-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();

    try {
      const execution = tools.agent.execute(
        "call-watchdog-tool-idle-deadlines",
        {
          agent: "worker",
          task: "Expire tool and idle deadlines together",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: 1, toolSeconds: 1, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      child.stdout.emit(
        "data",
        `${JSON.stringify({ type: "tool_execution_start", toolCallId: "same-time", toolName: "read" })}\n`,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(6_000);
      const result = await execution;

      expect(result.details.results[0].termination).toMatchObject({
        kind: "watchdog",
        deadline: "tool",
        activeTool: "read",
      });
    } finally {
      vi.useRealTimers();
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it.each([
    ["close callback runs first", true],
    ["watchdog callback runs first", false],
  ] as const)("handles completion exactly at the deadline when %s", async (_name, closeFirst) => {
    vi.useFakeTimers();
    const project = createPersistenceTestProject(
      "watchdog-exact-deadline-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(spawn).mockImplementation(() => {
      if (closeFirst) setTimeout(() => child.emit("close", 0, null), 1_000);
      else queueMicrotask(() => setTimeout(() => child.emit("close", 0, null), 1_000));
      return child as never;
    });
    const tools = registerPersistenceTestTools();

    try {
      const execution = tools.agent.execute(
        `call-watchdog-exact-deadline-${closeFirst}`,
        {
          agent: "worker",
          task: "Complete exactly at the idle deadline",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      if (!closeFirst) await vi.advanceTimersByTimeAsync(6_000);
      const result = await execution;

      if (closeFirst) {
        expect(result.details.results[0].termination).toBeUndefined();
        expect(child.kill).not.toHaveBeenCalled();
      } else {
        expect(result.details.results[0].termination).toMatchObject({
          kind: "watchdog",
          deadline: "idle",
        });
        expect(child.kill).toHaveBeenCalledTimes(1);
      }
    } finally {
      vi.useRealTimers();
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("treats a child close just before the deadline as completion, not timeout", async () => {
    const project = createPersistenceTestProject(
      "watchdog-close-race-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();
    const closeTimer = setTimeout(() => child.emit("close", 0, null), 700);

    try {
      const result = await tools.agent.execute(
        "call-watchdog-close-race",
        {
          agent: "worker",
          task: "Complete before the deadline",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(result.details.results[0].termination).toBeUndefined();
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      clearTimeout(closeTimer);
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "bounds cleanup and stops a real child process group on timeout",
    async () => {
      const project = createPersistenceTestProject(
        "watchdog-process-group-",
        "---\nname: worker\ndescription: Test worker\n---\n",
      );
      const fixturePath = path.join(project, "fixture.cjs");
      const readyPath = path.join(project, "ready");
      const signalPath = path.join(project, "signal");
      fs.writeFileSync(
        fixturePath,
        `const { spawn } = require("node:child_process");\n` +
          `const fs = require("node:fs");\n` +
          `const child = spawn(process.execPath, ["-e", ` +
          `${JSON.stringify(`const fs = require("node:fs"); process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(signalPath)}, "SIGTERM"); process.exit(0); }); fs.writeFileSync(${JSON.stringify(readyPath)}, "ready"); setTimeout(() => process.exit(0), 8000);`)}], ` +
          `{ stdio: "ignore" });\n` +
          `process.on("SIGTERM", () => {});\n` +
          `setTimeout(() => process.exit(0), 8000);\n`,
      );
      let leader: ReturnType<typeof realSpawn> | undefined;
      vi.mocked(spawn).mockImplementation((_command, _args, options) => {
        leader = realSpawn(process.execPath, [fixturePath], options);
        return leader as never;
      });
      const tools = registerPersistenceTestTools();
      const startedAt = Date.now();

      try {
        const execution = tools.agent.execute(
          "call-watchdog-process-group",
          {
            agent: "worker",
            task: "Run the subprocess fixture",
            agentScope: "project",
            confirmProjectAgents: false,
            watchdog: { idleSeconds: 2, toolSeconds: null, taskSeconds: null },
          },
          undefined,
          undefined,
          {
            cwd: project,
            hasUI: false,
            sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
          },
        );
        await vi.waitFor(() => expect(fs.existsSync(readyPath)).toBe(true));
        const result = await execution;

        expect(result.isError).toBe(true);
        expect(Date.now() - startedAt).toBeLessThan(8_000);
        expect(result.details.results[0].termination).toMatchObject({
          kind: "watchdog",
          cleanup: "unknown",
        });
        await vi.waitFor(() => expect(fs.readFileSync(signalPath, "utf8")).toBe("SIGTERM"));
      } finally {
        if (leader && leader.exitCode === null && leader.signalCode === null)
          leader.kill("SIGKILL");
        vi.mocked(spawn).mockReset();
        vi.unstubAllEnvs();
        fs.rmSync(project, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it.runIf(process.platform !== "win32")(
    "escalates to kill a real descendant that ignores SIGTERM",
    async () => {
      const project = createPersistenceTestProject(
        "watchdog-group-escalation-",
        "---\nname: worker\ndescription: Test worker\n---\n",
      );
      const fixturePath = path.join(project, "fixture.cjs");
      const readyPath = path.join(project, "ready");
      const signalPath = path.join(project, "signal");
      const descendant = `const fs = require("node:fs");
process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(signalPath)}, "SIGTERM"));
fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
setTimeout(() => process.exit(0), 12000);`;
      fs.writeFileSync(
        fixturePath,
        `const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "ignore"] });
setTimeout(() => process.exit(0), 12000);`,
      );
      let leader: ReturnType<typeof realSpawn> | undefined;
      let groupClosed: Promise<void> | undefined;
      vi.mocked(spawn).mockImplementation((_command, _args, options) => {
        leader = realSpawn(process.execPath, [fixturePath], options);
        groupClosed = new Promise((resolve) => leader?.once("close", () => resolve()));
        return leader as never;
      });
      const tools = registerPersistenceTestTools();
      const startedAt = Date.now();

      try {
        const execution = tools.agent.execute(
          "call-watchdog-group-escalation",
          {
            agent: "worker",
            task: "Run the subprocess fixture",
            agentScope: "project",
            confirmProjectAgents: false,
            watchdog: { idleSeconds: 2, toolSeconds: null, taskSeconds: null },
          },
          undefined,
          undefined,
          {
            cwd: project,
            hasUI: false,
            sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
          },
        );
        await vi.waitFor(() => expect(fs.existsSync(readyPath)).toBe(true));
        const result = await execution;
        expect(result.details.results[0].termination).toMatchObject({ kind: "watchdog" });
        expect(fs.readFileSync(signalPath, "utf8")).toBe("SIGTERM");
        await groupClosed;
        expect(leader?.signalCode).toBe("SIGKILL");
        expect(Date.now() - startedAt).toBeLessThan(10_000);
      } finally {
        if (leader && leader.exitCode === null && leader.signalCode === null)
          leader.kill("SIGKILL");
        await groupClosed;
        vi.mocked(spawn).mockReset();
        vi.unstubAllEnvs();
        fs.rmSync(project, { recursive: true, force: true });
      }
    },
    16_000,
  );

  it("does not signal a process group after its leader exits and keeps cleanup unknown", async () => {
    const project = createPersistenceTestProject(
      "watchdog-exited-leader-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = Object.assign(createPersistenceTestChild(), { pid: 45_678 });
    vi.mocked(spawn).mockReturnValue(child as never);
    const processKill = vi.spyOn(process, "kill").mockReturnValue(true);
    const tools = registerPersistenceTestTools();
    const exitTimer = setTimeout(() => child.emit("exit", 0, null), 100);

    try {
      const result = await tools.agent.execute(
        "call-watchdog-exited-leader",
        {
          agent: "worker",
          task: "Time out after the direct child has exited",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(result.details.results[0].termination).toMatchObject({
        kind: "watchdog",
        deadline: "idle",
        cleanup: "unknown",
      });
      expect(processKill).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      clearTimeout(exitTimer);
      processKill.mockRestore();
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 8_000);

  it("rejects invalid watchdog limits before spawning a child", async () => {
    const project = createPersistenceTestProject(
      "invalid-watchdog-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const tools = registerPersistenceTestTools();
    try {
      const result = await tools.agent.execute(
        "call-invalid-watchdog",
        {
          agent: "worker",
          task: "must not start",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: 0 },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("positive integer seconds");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("returns an aborted result without spawning or cleanup when already aborted", async () => {
    const project = createPersistenceTestProject(
      "already-aborted-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const processKill = vi.spyOn(process, "kill");
    const controller = new AbortController();
    controller.abort();
    const tools = registerPersistenceTestTools();
    try {
      const result = await tools.agent.execute(
        "call-already-aborted",
        {
          agent: "worker",
          task: "Do not start",
          agentScope: "project",
          confirmProjectAgents: false,
        },
        controller.signal,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );
      expect(spawn).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
      expect(processKill).not.toHaveBeenCalled();
      expect(result.details.results[0].stopReason).toBe("aborted");
      expect(result.details.results[0].termination).toBeUndefined();
      expect(result.content[0].text).not.toContain("Cleanup: unknown");
      expect(fs.readFileSync(result.details.results[0].outputPath!, "utf8")).not.toContain(
        "Cleanup: unknown",
      );
    } finally {
      processKill.mockRestore();
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "signals the dedicated group when the parent aborts",
    async () => {
      const project = createPersistenceTestProject(
        "abort-process-group-",
        "---\nname: worker\ndescription: Test worker\n---\n",
      );
      const child = Object.assign(createPersistenceTestChild(), { pid: 45_678 });
      child.kill.mockImplementation(() => {
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
        return true;
      });
      vi.mocked(spawn).mockReturnValue(child as never);
      const processKill = vi.spyOn(process, "kill").mockImplementation(() => {
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
        return true;
      });
      const controller = new AbortController();
      const tools = registerPersistenceTestTools();
      try {
        const execution = tools.agent.execute(
          "call-abort-group",
          { agent: "worker", task: "Abort", agentScope: "project", confirmProjectAgents: false },
          controller.signal,
          undefined,
          {
            cwd: project,
            hasUI: false,
            sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
          },
        );
        await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
        controller.abort();
        const result = await execution;
        expect(processKill).toHaveBeenCalledWith(-45_678, "SIGTERM");
        expect(result.details.results[0].stopReason).toBe("aborted");
        expect(result.details.results[0].termination).toEqual({
          kind: "abort",
          cleanup: "unknown",
        });
        expect(result.content[0].text).toContain("Cleanup: unknown");
        expect(fs.readFileSync(result.details.results[0].outputPath!, "utf8")).toContain(
          "Cleanup: unknown",
        );
      } finally {
        processKill.mockRestore();
        vi.mocked(spawn).mockReset();
        vi.unstubAllEnvs();
        fs.rmSync(project, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "stops a real child and descendant when the parent aborts",
    async () => {
      const project = createPersistenceTestProject(
        "abort-real-group-",
        "---\nname: worker\ndescription: Test worker\n---\n",
      );
      const fixturePath = path.join(project, "fixture.cjs");
      const readyPath = path.join(project, "ready");
      const signalPath = path.join(project, "signal");
      fs.writeFileSync(
        fixturePath,
        `const { spawn } = require("node:child_process");\n` +
          `spawn(process.execPath, ["-e", ${JSON.stringify(`const fs = require("node:fs"); process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(signalPath)}, "SIGTERM"); process.exit(0); }); fs.writeFileSync(${JSON.stringify(readyPath)}, "ready"); setTimeout(() => process.exit(0), 8000);`)}], { stdio: "ignore" });\n` +
          `process.on("SIGTERM", () => {});\n` +
          `setTimeout(() => process.exit(0), 8000);\n`,
      );
      let leader: ReturnType<typeof realSpawn> | undefined;
      vi.mocked(spawn).mockImplementation((_command, _args, options) => {
        leader = realSpawn(process.execPath, [fixturePath], options);
        return leader as never;
      });
      const controller = new AbortController();
      const tools = registerPersistenceTestTools();
      try {
        const execution = tools.agent.execute(
          "call-abort-real-group",
          { agent: "worker", task: "Abort", agentScope: "project", confirmProjectAgents: false },
          controller.signal,
          undefined,
          {
            cwd: project,
            hasUI: false,
            sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
          },
        );
        await vi.waitFor(() => expect(fs.existsSync(readyPath)).toBe(true));
        controller.abort();
        const result = await execution;
        expect(result.details.results[0].stopReason).toBe("aborted");
        await vi.waitFor(() => expect(fs.readFileSync(signalPath, "utf8")).toBe("SIGTERM"));
      } finally {
        controller.abort();
        if (leader && leader.exitCode === null && leader.signalCode === null)
          leader.kill("SIGKILL");
        vi.mocked(spawn).mockReset();
        vi.unstubAllEnvs();
        fs.rmSync(project, { recursive: true, force: true });
      }
    },
    10_000,
  );

  it("returns an aborted result when the parent aborts before the watchdog deadline and the child stays open", async () => {
    const project = createPersistenceTestProject(
      "watchdog-abort-race-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 100);

    try {
      const startedAt = Date.now();
      const result = await tools.agent.execute(
        "call-watchdog-abort-race",
        {
          agent: "worker",
          task: "Abort before the idle deadline",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
        },
        controller.signal,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(Date.now() - startedAt).toBeLessThan(8_000);
      expect(result.details.results[0].stopReason).toBe("aborted");
      expect(result.details.results[0].termination).toEqual({ kind: "abort", cleanup: "unknown" });
    } finally {
      clearTimeout(abortTimer);
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 9_000);

  it.runIf(process.platform !== "win32")(
    "keeps the timeout result and bounds cleanup when signals fail and abort arrives later",
    async () => {
      const project = createPersistenceTestProject(
        "watchdog-signal-failure-",
        "---\nname: worker\ndescription: Test worker\n---\n",
      );
      const child = Object.assign(createPersistenceTestChild(), { pid: 45_678 });
      child.kill.mockImplementation(() => {
        throw new Error("signal rejected");
      });
      vi.mocked(spawn).mockReturnValue(child as never);
      const processKill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("signal rejected");
      });
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 1500);
      const tools = registerPersistenceTestTools();
      const startedAt = Date.now();
      try {
        const result = await tools.agent.execute(
          "call-watchdog-signal-failure",
          {
            agent: "worker",
            task: "Timeout before abort",
            agentScope: "project",
            confirmProjectAgents: false,
            watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
          },
          controller.signal,
          undefined,
          {
            cwd: project,
            hasUI: false,
            sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
          },
        );
        expect(Date.now() - startedAt).toBeLessThan(8_000);
        expect(result.details.results[0].termination).toMatchObject({
          kind: "watchdog",
          deadline: "idle",
          cleanup: "unknown",
        });
        expect(processKill).toHaveBeenCalledWith(-45_678, "SIGTERM");
        expect(processKill).toHaveBeenCalledWith(-45_678, "SIGKILL");
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        clearTimeout(abortTimer);
        processKill.mockRestore();
        vi.mocked(spawn).mockReset();
        vi.unstubAllEnvs();
        fs.rmSync(project, { recursive: true, force: true });
      }
    },
    9_000,
  );

  it("enforces the tool deadline while assistant text continues to stream", async () => {
    const project = createPersistenceTestProject(
      "watchdog-tool-deadline-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();
    const emitText = () =>
      child.stdout.emit(
        "data",
        `${JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working" },
        })}\n`,
      );
    const eventTimers = [
      setTimeout(
        () =>
          child.stdout.emit(
            "data",
            `${JSON.stringify({ type: "tool_execution_start", toolCallId: "long-tool", toolName: "read" })}\n`,
          ),
        100,
      ),
      ...[300, 500, 700, 900, 1_100].map((delay) => setTimeout(emitText, delay)),
    ];

    try {
      const resultPromise = tools.agent.execute(
        "call-watchdog-tool-deadline",
        {
          agent: "worker",
          task: "Keep producing assistant output inside a long tool call",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: null, toolSeconds: 1, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );
      const result = await resultPromise;

      expect(result.details.results[0].termination).toMatchObject({
        kind: "watchdog",
        deadline: "tool",
        activeTool: "read",
      });
    } finally {
      for (const timer of eventTimers) clearTimeout(timer);
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 5_000);

  it("enforces the task deadline while assistant text continues to stream", async () => {
    const project = createPersistenceTestProject(
      "watchdog-task-deadline-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();
    const progressTimer = setInterval(
      () =>
        child.stdout.emit(
          "data",
          `${JSON.stringify({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working" },
          })}\n`,
        ),
      200,
    );

    try {
      const result = await tools.agent.execute(
        "call-watchdog-task-deadline",
        {
          agent: "worker",
          task: "Keep producing assistant output beyond the run deadline",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: null, toolSeconds: null, taskSeconds: 1 },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(result.details.results[0].termination).toMatchObject({
        kind: "watchdog",
        deadline: "task",
      });
    } finally {
      clearInterval(progressTimer);
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 5_000);

  it.each(["parallel", "chain"] as const)(
    "applies an item watchdog override in %s mode",
    async (mode) => {
      const project = createPersistenceTestProject(
        `watchdog-item-override-${mode}-`,
        "---\nname: worker\ndescription: Test worker\n---\n",
      );
      const child = createPersistenceTestChild();
      child.kill.mockImplementation(() => {
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
        return true;
      });
      vi.mocked(spawn).mockReturnValue(child as never);
      const tools = registerPersistenceTestTools();
      const progressTimer = setInterval(
        () =>
          child.stdout.emit(
            "data",
            `${JSON.stringify({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working" },
            })}\n`,
          ),
        200,
      );

      try {
        const result = await tools.agent.execute(
          `call-watchdog-item-override-${mode}`,
          {
            [mode === "parallel" ? "tasks" : "chain"]: [
              { agent: "worker", task: "Use the item task deadline", watchdog: { taskSeconds: 1 } },
            ],
            watchdog: { idleSeconds: null, toolSeconds: null, taskSeconds: null },
            agentScope: "project",
            confirmProjectAgents: false,
          },
          undefined,
          undefined,
          {
            cwd: project,
            hasUI: false,
            sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
          },
        );

        expect(result.details.results[0].termination).toMatchObject({
          kind: "watchdog",
          deadline: "task",
        });
      } finally {
        clearInterval(progressTimer);
        vi.mocked(spawn).mockReset();
        vi.unstubAllEnvs();
        fs.rmSync(project, { recursive: true, force: true });
      }
    },
  );

  it("treats nonempty reasoning deltas as idle-deadline progress", async () => {
    const project = createPersistenceTestProject(
      "watchdog-reasoning-progress-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();
    const thinkingEvent = () =>
      `${JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "reasoning" },
      })}\n`;
    const reasoningTimers = [
      setTimeout(() => child.stdout.emit("data", thinkingEvent()), 600),
      setTimeout(() => child.stdout.emit("data", thinkingEvent()), 1_200),
    ];
    const closeTimer = setTimeout(() => child.emit("close", 0, null), 1_500);

    try {
      const result = await tools.agent.execute(
        "call-watchdog-reasoning-progress",
        {
          agent: "worker",
          task: "Keep reasoning without producing text",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(result.details.results[0].termination).toBeUndefined();
    } finally {
      for (const timer of reasoningTimers) clearTimeout(timer);
      clearTimeout(closeTimer);
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 5_000);

  it("does not reset the idle deadline for unmatched or duplicate tool-end events", async () => {
    const project = createPersistenceTestProject(
      "watchdog-unmatched-tool-end-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();
    const endTimers = [
      setTimeout(() => {
        child.stdout.emit(
          "data",
          `${JSON.stringify({ type: "tool_execution_start", toolCallId: "started", toolName: "read" })}\n`,
        );
      }, 100),
      setTimeout(() => {
        const event = (toolCallId: string) =>
          `${JSON.stringify({ type: "tool_execution_end", toolCallId, result: "done" })}\n`;
        child.stdout.emit("data", event("started"));
      }, 200),
      setTimeout(() => {
        const event = (toolCallId: string) =>
          `${JSON.stringify({ type: "tool_execution_end", toolCallId, result: "done" })}\n`;
        child.stdout.emit("data", event("unmatched"));
        child.stdout.emit("data", event("started"));
      }, 700),
    ];

    try {
      const startedAt = Date.now();
      const result = await tools.agent.execute(
        "call-watchdog-unmatched-tool-end",
        {
          agent: "worker",
          task: "Ignore unmatched tool-end events as progress",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(result.details.results[0].termination).toMatchObject({
        kind: "watchdog",
        deadline: "idle",
      });
      expect(Date.now() - startedAt).toBeLessThan(1_500);
    } finally {
      for (const timer of endTimers) clearTimeout(timer);
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 5_000);

  it("keeps the first timeout and bounded cleanup when tool events arrive during cleanup", async () => {
    const project = createPersistenceTestProject(
      "watchdog-cleanup-events-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    child.kill.mockReturnValue(true);
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();
    const sensitiveToolName = `secret\n${"tool".repeat(40)}`;
    const toolStart = setTimeout(() => {
      child.stdout.emit(
        "data",
        `${JSON.stringify({ type: "tool_execution_start", toolCallId: "early-call", toolName: sensitiveToolName })}\n`,
      );
    }, 100);
    const cleanupEvents = setTimeout(() => {
      child.stdout.emit(
        "data",
        `${JSON.stringify({ type: "tool_execution_start", toolCallId: "late-call", toolName: "read" })}\n` +
          `${JSON.stringify({ type: "tool_execution_update", toolCallId: "late-call", partialResult: "still working" })}\n`,
      );
    }, 1_200);

    try {
      const startedAt = Date.now();
      const result = await tools.agent.execute(
        "call-watchdog-cleanup-events",
        {
          agent: "worker",
          task: "Keep emitting tool events during cleanup",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(result.details.results[0].termination).toMatchObject({
        kind: "watchdog",
        deadline: "idle",
        limitSeconds: 1,
        cleanup: "unknown",
        activeTool: "redacted",
      });
      expect(result.details.results[0].termination?.toolElapsedSeconds).toBeGreaterThanOrEqual(0);
      const summary = result.details.results[0].errorMessage;
      expect(summary).toContain("idle deadline (1s)");
      expect(summary).toMatch(/elapsed: \d+s/);
      expect(summary).toMatch(/progress age: \d+s/);
      expect(summary).toMatch(/active tool: [a-zA-Z0-9_.:-]{1,64} \(\d+s\)/);
      expect(summary).toContain("cleanup: unknown");
      expect(summary).not.toContain("secret");
      expect(summary.length).toBeLessThan(300);
      expect(Date.now() - startedAt).toBeLessThan(7_800);
    } finally {
      clearTimeout(toolStart);
      clearTimeout(cleanupEvents);
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 9_000);

  it("does not reset idle timeout for identical tool updates longer than the stored bound", async () => {
    const project = createPersistenceTestProject(
      "watchdog-long-duplicate-update-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();
    const longUpdate = "x".repeat(9_000);
    const update = () =>
      child.stdout.emit(
        "data",
        `${JSON.stringify({ type: "tool_execution_update", toolCallId: "long-call", partialResult: longUpdate })}\n`,
      );
    const timers = [
      setTimeout(
        () =>
          child.stdout.emit(
            "data",
            `${JSON.stringify({ type: "tool_execution_start", toolCallId: "long-call", toolName: "read" })}\n`,
          ),
        100,
      ),
      setTimeout(update, 600),
      setTimeout(update, 1_200),
    ];

    try {
      const startedAt = Date.now();
      const result = await tools.agent.execute(
        "call-watchdog-long-duplicate-update",
        {
          agent: "worker",
          task: "Ignore identical long tool output as progress",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(result.details.results[0].termination).toMatchObject({
        deadline: "idle",
        elapsedSeconds: 2,
      });
      expect(Date.now() - startedAt).toBeLessThan(1_800);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 5_000);

  it("ignores malformed event shapes and does not reset a duplicate tool start deadline", async () => {
    const project = createPersistenceTestProject(
      "watchdog-duplicate-tool-start-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();
    const timers = [
      setTimeout(
        () =>
          child.stdout.emit(
            "data",
            [
              "null",
              "[]",
              JSON.stringify({ type: "message_update", assistantMessageEvent: [] }),
              "",
            ].join("\n"),
          ),
        50,
      ),
      setTimeout(() => {
        const start = JSON.stringify({
          type: "tool_execution_start",
          toolCallId: "same-id",
          toolName: "read",
        });
        child.stdout.emit("data", `${start}\n`);
      }, 100),
      setTimeout(() => {
        child.stdout.emit(
          "data",
          `${JSON.stringify({
            type: "tool_execution_start",
            toolCallId: "same-id",
            toolName: "write",
          })}\n`,
        );
      }, 700),
    ];

    try {
      const startedAt = Date.now();
      const result = await tools.agent.execute(
        "call-watchdog-duplicate-tool-start",
        {
          agent: "worker",
          task: "Ignore malformed events and duplicate tool starts",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: null, toolSeconds: 1, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(result.details.results[0].termination).toMatchObject({
        kind: "watchdog",
        deadline: "tool",
        activeTool: "read",
      });
      expect(Date.now() - startedAt).toBeLessThan(1_600);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 5_000);

  it("returns a clear failure when a timeout artifact cannot be written", async () => {
    const project = createPersistenceTestProject(
      "watchdog-artifact-failure-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const sessionFile = path.join(project, "session.jsonl");
    const outputPath = buildArtifactPath({
      sessionFile,
      toolCallId: "call-watchdog-artifact-failure",
      mode: "single",
      agent: "worker",
    });
    fs.mkdirSync(outputPath, { recursive: true });
    const child = createPersistenceTestChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();

    try {
      await expect(
        tools.agent.execute(
          "call-watchdog-artifact-failure",
          {
            agent: "worker",
            task: "Time out but fail to persist the result",
            agentScope: "project",
            confirmProjectAgents: false,
            watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
          },
          undefined,
          undefined,
          {
            cwd: project,
            hasUI: false,
            sessionManager: { getSessionFile: () => sessionFile },
          },
        ),
      ).rejects.toThrow("Unable to write subagent artifact");
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 5_000);

  it("starts a queued parallel task deadline when its child starts", async () => {
    const project = createPersistenceTestProject(
      "watchdog-parallel-queue-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const children: Array<ReturnType<typeof createPersistenceTestChild>> = [];
    vi.mocked(spawn).mockImplementation(() => {
      const child = createPersistenceTestChild();
      const index = children.push(child);
      if (index < 5) setTimeout(() => child.emit("close", 0, null), 200);
      else {
        child.kill.mockImplementation(() => {
          queueMicrotask(() => child.emit("close", null, "SIGTERM"));
          return true;
        });
      }
      return child as never;
    });
    const tools = registerPersistenceTestTools();

    try {
      const startedAt = Date.now();
      const result = await tools.agent.execute(
        "call-watchdog-parallel-queue",
        {
          tasks: Array.from({ length: 5 }, (_, index) => ({
            agent: "worker",
            task: `Parallel item ${index + 1}`,
          })),
          watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
          agentScope: "project",
          confirmProjectAgents: false,
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(children).toHaveLength(5);
      expect(result.details.results.slice(0, 4).every((item: any) => !item.termination)).toBe(true);
      expect(result.details.results[4].termination).toMatchObject({
        kind: "watchdog",
        deadline: "idle",
      });
      expect(Date.now() - startedAt).toBeLessThan(1_800);
    } finally {
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 5_000);

  it("tracks concurrent tool deadlines by tool ID", async () => {
    const project = createPersistenceTestProject(
      "watchdog-concurrent-tools-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();
    const timers = [
      setTimeout(
        () =>
          child.stdout.emit(
            "data",
            `${JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-a", toolName: "read" })}\n`,
          ),
        100,
      ),
      setTimeout(
        () =>
          child.stdout.emit(
            "data",
            `${JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-b", toolName: "write" })}\n`,
          ),
        200,
      ),
    ];

    try {
      const result = await tools.agent.execute(
        "call-watchdog-concurrent-tools",
        {
          agent: "worker",
          task: "Keep two tools active concurrently",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: null, toolSeconds: 1, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(result.details.results[0].termination).toMatchObject({
        deadline: "tool",
        activeTool: "read",
      });
    } finally {
      for (const timer of timers) clearTimeout(timer);
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 5_000);

  it("stops a chain after a timed-out step without starting the next step", async () => {
    const project = createPersistenceTestProject(
      "watchdog-chain-stop-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();

    try {
      const result = await tools.agent.execute(
        "call-watchdog-chain-stop",
        {
          chain: [
            { agent: "worker", task: "First step" },
            { agent: "worker", task: "Second step receives {previous}" },
          ],
          watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
          agentScope: "project",
          confirmProjectAgents: false,
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(result.isError).toBe(true);
      expect(result.details.results).toHaveLength(1);
      expect(result.details.results[0].termination).toMatchObject({ kind: "watchdog" });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(result.details.results[0].outputPath)).toBe(true);
    } finally {
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 5_000);

  it("keeps the watchdog active after session shutdown closes the inspector", async () => {
    const project = createPersistenceTestProject(
      "watchdog-session-shutdown-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const events: Record<string, () => void> = {};
    const tools = registerPersistenceTestTools(undefined, events);

    try {
      const execution = tools.agent.execute(
        "call-watchdog-session-shutdown",
        {
          agent: "worker",
          task: "Keep the watchdog active after session shutdown",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      events.session_shutdown?.();
      const result = await execution;

      expect(child.kill).toHaveBeenCalled();
      expect(result.details.results[0].stopReason).toBeUndefined();
      expect(result.details.results[0].termination).toMatchObject({
        kind: "watchdog",
        deadline: "idle",
      });
    } finally {
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 5_000);

  it("keeps the task deadline across model fallback attempts", async () => {
    const project = createPersistenceTestProject(
      "watchdog-fallback-deadline-",
      "---\nname: worker\ndescription: Test worker\nmodel: test/fallback\n---\n",
    );
    const children: Array<ReturnType<typeof createPersistenceTestChild>> = [];
    vi.mocked(spawn).mockImplementation(() => {
      const child = createPersistenceTestChild();
      children.push(child);
      if (children.length === 1) {
        setTimeout(() => {
          child.stderr.emit("data", "No API key configured");
          child.emit("close", 1, null);
        }, 50);
      } else {
        child.kill.mockImplementation(() => {
          queueMicrotask(() => child.emit("close", null, "SIGTERM"));
          return true;
        });
        const timer = setInterval(
          () =>
            child.stdout.emit(
              "data",
              `${JSON.stringify({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working" },
              })}\n`,
            ),
          100,
        );
        child.once("close", () => clearInterval(timer));
      }
      return child as never;
    });
    const tools = registerPersistenceTestTools();

    try {
      const result = await tools.agent.execute(
        "call-watchdog-fallback-deadline",
        {
          agent: "worker",
          task: "Keep the deadline across fallback attempts",
          model: "test/primary",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: null, toolSeconds: null, taskSeconds: 1 },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(children).toHaveLength(2);
      expect(result.details.results[0].termination).toMatchObject({
        kind: "watchdog",
        deadline: "task",
      });
    } finally {
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 5_000);

  it("returns a timeout artifact when a child makes no progress", async () => {
    const project = createPersistenceTestProject(
      "watchdog-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();
    const fallback = setTimeout(() => child.emit("close", 0, null), 2000);

    try {
      const result = await tools.agent.execute(
        "call-watchdog",
        {
          agent: "worker",
          task: "Run a silent task",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(result.isError).toBe(true);
      expect(result.details.results[0].termination).toMatchObject({
        kind: "watchdog",
        deadline: "idle",
      });
      expect(result.content[0].text).toContain("timed out");
      const artifact = fs.readFileSync(result.details.results[0].outputPath, "utf8");
      expect(artifact).toContain("idle");
      expect(artifact).not.toContain("Status: completed");
    } finally {
      clearTimeout(fallback);
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 5000);
});

describe("subagent process launch", () => {
  it.each([
    "SDK host",
    "Pi CLI",
    "symlinked Pi CLI",
    "bundled Pi CLI",
    "symlinked bundled Pi CLI",
    "compiled Pi binary",
  ])("launches Pi from a %s parent without rerunning an SDK host", async (parentKind) => {
    const project = createPersistenceTestProject(
      "sdk-launch-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const hostScript = path.join(project, "workbench-server.mjs");
    fs.writeFileSync(
      hostScript,
      "import { createServer } from 'node:net';\n" +
        "createServer().listen(Number(process.env.PORT), '127.0.0.1');\n",
    );
    const originalArgv = process.argv;
    const originalExecPath = process.execPath;
    const installedCli = parentKind.includes("bundled")
      ? path.join(getPackageDir(), "dist", "bundle", "cli.js")
      : path.join(getPackageDir(), "dist", "cli.js");
    const cliSymlink = path.join(project, "pi-cli.js");
    fs.symlinkSync(installedCli, cliSymlink);
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    vi.spyOn(child, "kill").mockReturnValue(true);
    vi.mocked(spawn).mockReturnValue(child);
    const tools = registerPersistenceTestTools();
    try {
      if (parentKind === "compiled Pi binary") {
        process.execPath = path.join(project, "pi");
        process.argv = [process.execPath];
      } else {
        const parentScript =
          parentKind === "Pi CLI" || parentKind === "bundled Pi CLI"
            ? installedCli
            : parentKind === "symlinked Pi CLI" || parentKind === "symlinked bundled Pi CLI"
              ? cliSymlink
              : hostScript;
        process.argv = [process.execPath, parentScript];
      }
      const execution = tools.agent.execute(
        "call-sdk-launch",
        {
          agent: "worker",
          task: "Inspect the workspace",
          agentScope: "project",
          confirmProjectAgents: false,
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      const invocation = vi.mocked(spawn).mock.calls[0];
      child.emit("close", 0, null);
      await execution;
      expect(invocation?.[0]).toBe(process.execPath);
      const expectedEntry =
        parentKind === "compiled Pi binary"
          ? "--mode"
          : parentKind === "symlinked Pi CLI" || parentKind === "symlinked bundled Pi CLI"
            ? cliSymlink
            : installedCli;
      expect(invocation?.[1]?.[0]).toBe(expectedEntry);
      expect(invocation?.[1]).not.toContain(hostScript);
      if (parentKind === "SDK host") {
        const listener = createServer();
        try {
          await new Promise<void>((resolve, reject) => {
            listener.once("error", reject);
            listener.listen(0, "127.0.0.1", resolve);
          });
          const address = listener.address();
          if (!address || typeof address === "string") throw new Error("Expected a temporary port");
          const command = invocation?.[0];
          const entry = invocation?.[1]?.[0];
          if (typeof command !== "string" || typeof entry !== "string")
            throw new Error("Expected a Pi child invocation");
          const help = spawnSync(command, [entry, "--help"], {
            cwd: project,
            encoding: "utf8",
            timeout: 10_000,
            env: {
              ...process.env,
              PORT: String(address.port),
              PI_CODING_AGENT_SESSION_DIR: path.join(project, "sessions"),
              PI_OFFLINE: "1",
              PI_SKIP_VERSION_CHECK: "1",
            },
          });
          expect(help.error).toBeUndefined();
          expect(help.status, help.stderr).toBe(0);
          expect(help.stdout).toContain("--mode");
          expect(help.stderr).not.toContain("EADDRINUSE");
        } finally {
          await new Promise<void>((resolve) => listener.close(() => resolve()));
        }
      }
    } finally {
      process.argv = originalArgv;
      process.execPath = originalExecPath;
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("subagent tool guidance", () => {
  it("tells callers to omit model and thinking unless the user requests an override", () => {
    const tools = registerPersistenceTestTools();

    expect(tools.agent.description).toContain(
      "Omit model and thinking by default; set either only when the user explicitly requests an override.",
    );
    expect(tools.agent.description).toContain("'inherit' is an explicit override");
  });
});

describe("subagent execution options", () => {
  it("uses explicit parent model and thinking instead of scout settings", async () => {
    const project = createPersistenceTestProject(
      "explicit-inherit-",
      "---\nname: worker\ndescription: Test worker\nmodel: frontmatter/model\nthinking: high\n---\n",
    );
    fs.writeFileSync(
      path.join(project, "settings.json"),
      JSON.stringify({
        subagents: { agentOverrides: { worker: { model: "settings/model", thinking: "low" } } },
      }),
    );
    const child = createPersistenceTestChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools("xhigh");

    try {
      const execution = tools.agent.execute(
        "call-explicit-inherit",
        {
          agent: "worker",
          task: "review",
          model: "inherit",
          thinking: "inherit",
          agentScope: "project",
          confirmProjectAgents: false,
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          model: { provider: "openai", id: "gpt-5" },
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      const args = vi.mocked(spawn).mock.calls[0]?.[1] ?? [];
      child.emit("close", 0, null);
      const result = await execution;

      expect(args).toEqual(
        expect.arrayContaining(["--model", "openai/gpt-5", "--thinking", "xhigh"]),
      );
      expect(result.details.results[0]).toMatchObject({ model: "openai/gpt-5", thinking: "xhigh" });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
      vi.mocked(spawn).mockReset();
    }
  });

  it.each(["parallel", "chain"] as const)(
    "uses item model inheritance and explicit thinking in %s mode",
    async (mode) => {
      const project = createPersistenceTestProject(
        "item-options-",
        "---\nname: worker\ndescription: Test worker\n---\n",
      );
      fs.writeFileSync(
        path.join(project, "settings.json"),
        JSON.stringify({
          subagents: { agentOverrides: { worker: { model: "settings/model", thinking: "low" } } },
        }),
      );
      const child = createPersistenceTestChild();
      vi.mocked(spawn).mockReturnValue(child as never);
      const tools = registerPersistenceTestTools("xhigh");

      try {
        const item = { agent: "worker", task: "review", model: "inherit", thinking: "off" };
        const execution = tools.agent.execute(
          `call-${mode}-options`,
          {
            [mode === "parallel" ? "tasks" : "chain"]: [item],
            model: "top/model",
            thinking: "high",
            agentScope: "project",
            confirmProjectAgents: false,
          },
          undefined,
          undefined,
          {
            cwd: project,
            hasUI: false,
            model: { provider: "openai", id: "gpt-5" },
            sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
          },
        );

        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
        const args = vi.mocked(spawn).mock.calls[0]?.[1] ?? [];
        child.emit("close", 0, null);
        const result = await execution;

        expect(args).toEqual(
          expect.arrayContaining(["--model", "openai/gpt-5", "--thinking", "off"]),
        );
        expect(result.details.results[0]).toMatchObject({ model: "openai/gpt-5", thinking: "off" });
      } finally {
        fs.rmSync(project, { recursive: true, force: true });
        vi.mocked(spawn).mockReset();
      }
    },
  );

  it.each(["xhigh", "off"] as const)(
    "inherits parent thinking %s when the agent has no thinking setting",
    async (thinkingLevel) => {
      const project = createPersistenceTestProject(
        "parent-thinking-",
        "---\nname: worker\ndescription: Test worker\n---\n",
      );
      const child = createPersistenceTestChild();
      vi.mocked(spawn).mockReturnValue(child as never);
      const tools = registerPersistenceTestTools(thinkingLevel);

      try {
        const execution = tools.agent.execute(
          "call-parent-thinking",
          { agent: "worker", task: "review", agentScope: "project", confirmProjectAgents: false },
          undefined,
          undefined,
          {
            cwd: project,
            hasUI: false,
            model: { provider: "openai", id: "gpt-5" },
            sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
          },
        );

        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
        const args = vi.mocked(spawn).mock.calls[0]?.[1] ?? [];
        child.emit("close", 0, null);
        const result = await execution;

        expect(args).toEqual(
          expect.arrayContaining(["--model", "openai/gpt-5", "--thinking", thinkingLevel]),
        );
        expect(result.details.results[0]).toMatchObject({
          thinkingKind: "configured",
          thinking: thinkingLevel,
        });
      } finally {
        fs.rmSync(project, { recursive: true, force: true });
        vi.mocked(spawn).mockReset();
      }
    },
  );

  it("passes settings thinking and tools to the child process", async () => {
    const project = createPersistenceTestProject(
      "options-test-",
      "---\nname: worker\ndescription: Test worker\nthinking: high\ntools: read, rg\n---\n",
    );
    fs.writeFileSync(
      path.join(project, "settings.json"),
      JSON.stringify({
        subagents: {
          agentOverrides: {
            worker: { thinking: "medium", tools: ["write", "edit"] },
          },
        },
      }),
    );
    const child = createPersistenceTestChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools("xhigh");

    const execution = tools.agent.execute(
      "call-options",
      {
        agent: "worker",
        task: "check resolved options",
        agentScope: "project",
        confirmProjectAgents: false,
      },
      undefined,
      undefined,
      {
        cwd: project,
        hasUI: false,
        model: undefined,
        sessionManager: {
          getSessionFile: () => path.join(project, "session.jsonl"),
        },
      },
    );

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    const invocation = vi.mocked(spawn).mock.calls[0];
    const args = invocation?.[1] ?? [];
    child.emit("close", 0, null);
    await execution;

    expect(args).toEqual(expect.arrayContaining(["--thinking", "medium", "--tools", "write,edit"]));
    expect(args).not.toContain("read,rg");
    fs.rmSync(project, { recursive: true, force: true });
    vi.mocked(spawn).mockReset();
  });

  it("rejects an agent with invalid thinking frontmatter before spawning", async () => {
    const project = createPersistenceTestProject(
      "invalid-thinking-",
      "---\nname: worker\ndescription: Test worker\nthinking: HIGH\n---\n",
    );
    const tools = registerPersistenceTestTools();

    const result = await tools.agent.execute(
      "call-invalid-thinking",
      {
        agent: "worker",
        task: "should not run",
        agentScope: "project",
        confirmProjectAgents: false,
      },
      undefined,
      undefined,
      {
        cwd: project,
        hasUI: false,
        model: undefined,
        sessionManager: {
          getSessionFile: () => path.join(project, "session.jsonl"),
        },
      },
    );

    expect(spawn).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.details?.results[0].stderr).toContain("thinking must be one of");
    const artifact = getResultOutput(result.details.results[0]);
    expect(artifact).toContain("- Thinking: not run");
    expect(artifact).not.toContain("- Thinking: Pi default");
    fs.rmSync(project, { recursive: true, force: true });
    vi.mocked(spawn).mockReset();
  });

  it("writes a not-run artifact when settings.json cannot be parsed", async () => {
    const project = createPersistenceTestProject(
      "invalid-settings-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    fs.writeFileSync(path.join(project, "settings.json"), "{invalid json");
    const tools = registerPersistenceTestTools();

    try {
      const result = await tools.agent.execute(
        "call-invalid-settings",
        {
          agent: "worker",
          task: "should not run",
          agentScope: "project",
          confirmProjectAgents: false,
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          model: undefined,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(spawn).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.details?.results).toHaveLength(1);
      expect(result.details.results[0].stderr).toContain("settings.json is not valid JSON");
      expect(getResultOutput(result.details.results[0])).toContain("- Thinking: not run");
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
      vi.mocked(spawn).mockReset();
    }
  });

  it("writes a not-run artifact for each parallel task when settings cannot load", async () => {
    const project = createPersistenceTestProject(
      "invalid-parallel-settings-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    fs.writeFileSync(path.join(project, "settings.json"), "{invalid json");
    const tools = registerPersistenceTestTools();

    try {
      const result = await tools.agent.execute(
        "call-invalid-parallel-settings",
        {
          tasks: [
            { agent: "worker", task: "first task" },
            { agent: "worker", task: "second task" },
          ],
          agentScope: "project",
          confirmProjectAgents: false,
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          model: undefined,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(spawn).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.details?.mode).toBe("parallel");
      expect(result.details?.results).toHaveLength(2);
      for (const item of result.details.results) {
        expect(getResultOutput(item)).toContain("- Thinking: not run");
        expect(item.stderr).toContain("settings.json is not valid JSON");
        expect(result.content[0].text).toContain(item.outputPath);
      }
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
      vi.mocked(spawn).mockReset();
    }
  });

  it("stops a chain at its first not-run step when settings cannot load", async () => {
    const project = createPersistenceTestProject(
      "invalid-chain-settings-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    fs.writeFileSync(path.join(project, "settings.json"), "{invalid json");
    const tools = registerPersistenceTestTools();

    try {
      const result = await tools.agent.execute(
        "call-invalid-chain-settings",
        {
          chain: [
            { agent: "worker", task: "first step" },
            { agent: "worker", task: "second step" },
          ],
          agentScope: "project",
          confirmProjectAgents: false,
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          model: undefined,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(spawn).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.details?.mode).toBe("chain");
      expect(result.details?.results).toHaveLength(1);
      expect(result.details.results[0].step).toBe(1);
      expect(getResultOutput(result.details.results[0])).toContain("- Thinking: not run");
      expect(result.content[0].text).toContain(result.details.results[0].outputPath);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
      vi.mocked(spawn).mockReset();
    }
  });

  it("reports frontmatter and settings errors before spawning", async () => {
    const project = createPersistenceTestProject(
      "invalid-agent-config-",
      "---\nname: worker\ndescription: Test worker\nthinking: HIGH\n---\n",
    );
    fs.writeFileSync(
      path.join(project, "settings.json"),
      JSON.stringify({ subagents: { agentOverrides: { worker: { tools: [] } } } }),
    );
    const tools = registerPersistenceTestTools();

    const result = await tools.agent.execute(
      "call-invalid-agent-config",
      {
        agent: "worker",
        task: "should not run",
        agentScope: "project",
        confirmProjectAgents: false,
      },
      undefined,
      undefined,
      {
        cwd: project,
        hasUI: false,
        model: undefined,
        sessionManager: {
          getSessionFile: () => path.join(project, "session.jsonl"),
        },
      },
    );

    const error = result.details?.results[0].stderr ?? "";
    expect(spawn).not.toHaveBeenCalled();
    expect(error).toContain("thinking must be one of");
    expect(error).toContain("worker.tools must be a non-empty array");
    expect(error).toContain("; ");
    fs.rmSync(project, { recursive: true, force: true });
    vi.mocked(spawn).mockReset();
  });
});

describe("completed message events", () => {
  it.each([
    [
      "deferred assistant messages",
      {
        role: "assistant",
        content: [],
        api: "test-api",
        provider: "test-provider",
        model: "test-model",
        usage: {
          input: 1,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "deferred",
        timestamp: 1,
      },
    ],
    [
      "custom messages with string content",
      {
        role: "custom",
        customType: "test-message",
        content: "extension context",
        display: true,
        timestamp: 1,
      },
    ],
    [
      "bash execution messages without content",
      {
        role: "bashExecution",
        command: "printf test",
        output: "test",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 1,
      },
    ],
    [
      "branch summary messages",
      { role: "branchSummary", summary: "Earlier branch", fromId: null, timestamp: 1 },
    ],
    [
      "compaction summary messages",
      { role: "compactionSummary", summary: "Earlier context", tokensBefore: 100, timestamp: 1 },
    ],
  ])("accepts %s from a registered agent as progress", async (_name, message) => {
    const project = createPersistenceTestProject(
      "watchdog-message-variant-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();
    const emitMessage = setTimeout(() => {
      child.stdout.emit(
        "data",
        `${JSON.stringify({ type: "message_start", message })}\n` +
          `${JSON.stringify({ type: "message_end", message })}\n`,
      );
    }, 500);
    const closeChild = setTimeout(() => child.emit("close", 0, null), 1_250);

    try {
      const result = await tools.agent.execute(
        "call-watchdog-message-variant",
        {
          agent: "worker",
          task: "Accept a Pi message variant",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(result.details.results[0].termination).toBeUndefined();
      expect(result.details.results[0].exitCode).toBe(0);
    } finally {
      clearTimeout(emitMessage);
      clearTimeout(closeChild);
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("does not reset the idle deadline for malformed or unstarted message completions", async () => {
    const project = createPersistenceTestProject(
      "watchdog-malformed-message-end-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();
    const invalidCompletions = setTimeout(() => {
      child.stdout.emit(
        "data",
        `${JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "not started" }],
            api: "test-api",
            provider: "test-provider",
            model: "test-model",
            usage: {
              input: 4,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 6,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
            },
            stopReason: "stop",
            timestamp: 1,
          },
        })}\n` +
          `${JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              api: "test-api",
              provider: "test-provider",
              model: "test-model",
              stopReason: "stop",
            },
          })}\n` +
          `${JSON.stringify({ type: "message_end", message: { role: "unknown" } })}\n`,
      );
    }, 700);

    try {
      const startedAt = Date.now();
      const result = await tools.agent.execute(
        "call-watchdog-malformed-message-end",
        {
          agent: "worker",
          task: "Ignore malformed completed messages",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: 1, toolSeconds: null, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );

      expect(result.details.results[0].termination).toMatchObject({
        kind: "watchdog",
        deadline: "idle",
        elapsedSeconds: 1,
      });
      expect(Date.now() - startedAt).toBeLessThan(1_500);
    } finally {
      clearTimeout(invalidCompletions);
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  }, 5_000);

  it("counts distinct identical messages once each by their Pi event lifecycles", async () => {
    const project = createPersistenceTestProject(
      "identical-message-lifecycles-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const tools = registerPersistenceTestTools();
    const assistantMessage = (timestamp: number) => ({
      role: "assistant",
      content: [{ type: "text", text: "same completed response" }],
      api: "test-api",
      provider: "test-provider",
      model: "test-model",
      usage: {
        input: 3,
        output: 2,
        cacheRead: 1,
        cacheWrite: 0,
        totalTokens: 6,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
      },
      stopReason: "stop",
      timestamp,
    });

    try {
      const execution = tools.agent.execute(
        "call-identical-message-lifecycles",
        {
          agent: "worker",
          task: "Count both identical messages",
          agentScope: "project",
          confirmProjectAgents: false,
          watchdog: { idleSeconds: null, toolSeconds: null, taskSeconds: null },
        },
        undefined,
        undefined,
        {
          cwd: project,
          hasUI: false,
          sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
        },
      );
      await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
      for (const timestamp of [10, 11]) {
        const message = assistantMessage(timestamp);
        emitPersistenceTestMessage(child, message);
        child.stdout.emit("data", `${JSON.stringify({ type: "message_end", message })}\n`);
      }
      const toolResult = {
        role: "toolResult",
        toolCallId: "search-1",
        toolName: "web_search",
        content: [],
        usage: {
          input: 5,
          output: 4,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 12,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3 },
        },
        isError: false,
        timestamp: 12,
      };
      child.stdout.emit(
        "data",
        `${JSON.stringify({ type: "message_start", message: toolResult })}\n`,
      );
      const completedToolResult = `${JSON.stringify({ type: "message_end", message: toolResult })}\n`;
      child.stdout.emit("data", completedToolResult);
      child.stdout.emit("data", completedToolResult);
      child.emit("close", 0, null);

      const result = await execution;
      expect(result.details.results[0].usage).toMatchObject({
        input: 6,
        output: 4,
        cacheRead: 2,
        turns: 2,
      });
      expect(result.details.results[0].descendantUsage).toMatchObject({
        input: 5,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
      });
    } finally {
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("nested usage persistence", () => {
  it("captures nested agent and tool-result usage before artifact persistence clears messages", async () => {
    const project = createPersistenceTestProject(
      "nested-test-",
      "---\nname: worker\ndescription: Test worker\n---\n",
    );
    const child = createPersistenceTestChild();
    vi.mocked(spawn).mockReturnValue(child as never);

    const tools = registerPersistenceTestTools();

    const execution = tools.agent.execute(
      "call-parent",
      {
        agent: "worker",
        task: "parent task",
        agentScope: "project",
        confirmProjectAgents: false,
      },
      undefined,
      undefined,
      {
        cwd: project,
        hasUI: false,
        model: undefined,
        sessionManager: {
          getSessionFile: () => path.join(project, "session.jsonl"),
        },
      },
    );

    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

    const nestedDetails = {
      usageVersion: 2,
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [
        {
          agent: "nested-worker",
          agentSource: "user",
          task: "nested task",
          exitCode: 0,
          messages: [],
          stderr: "",
          usage: {
            input: 3,
            output: 2,
            cacheRead: 1,
            cacheWrite: 0,
            cost: 0.2,
            contextTokens: 6,
            turns: 1,
          },
        },
      ],
    };
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "parent output" }],
      api: "test-api",
      provider: "test-provider",
      model: "test-model",
      usage: {
        input: 10,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 17,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.5,
        },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    emitPersistenceTestMessage(child, assistantMessage);
    emitPersistenceTestMessage(child, {
      role: "toolResult",
      toolCallId: "nested-call",
      toolName: "agent",
      content: [],
      details: nestedDetails,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 1,
        cacheWrite: 1,
        totalTokens: 4,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.1,
        },
      },
      isError: false,
      timestamp: 1,
    });
    emitPersistenceTestMessage(child, {
      role: "toolResult",
      toolCallId: "tool-call",
      toolName: "web_search",
      content: [],
      usage: {
        input: 5,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 12,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.3,
        },
      },
      isError: false,
      timestamp: 2,
    });
    child.emit("close", 0, null);

    const result = await execution;

    expect(result.details?.results[0].descendantUsage).toMatchObject({
      input: 9,
      output: 7,
      cacheRead: 4,
      cacheWrite: 2,
    });
    expect(result.details?.results[0].descendantUsage?.cost).toBeCloseTo(0.6);
    expect(result.details?.usageVersion).toBe(3);
    expect(result.details?.results[0].descendantRuns).toBe(1);
    expect(result.details?.results[0].messages).toEqual([]);
    fs.rmSync(project, { recursive: true, force: true });
    vi.mocked(spawn).mockReset();
  });

  it("retains usage from failed model attempts when a fallback succeeds", async () => {
    const project = createPersistenceTestProject(
      "fallback-test-",
      "---\nname: worker\ndescription: Test worker\nmodel: test/fallback\n---\n",
    );
    const children: Array<ReturnType<typeof createPersistenceTestChild>> = [];
    vi.mocked(spawn).mockImplementation(() => {
      const child = createPersistenceTestChild();
      children.push(child);
      return child as never;
    });

    const tools = registerPersistenceTestTools();
    const execution = tools.agent.execute(
      "call-fallback",
      {
        agent: "worker",
        task: "fallback task",
        model: "test/primary",
        agentScope: "project",
        confirmProjectAgents: false,
      },
      undefined,
      undefined,
      {
        cwd: project,
        hasUI: false,
        model: undefined,
        sessionManager: {
          getSessionFile: () => path.join(project, "session.jsonl"),
        },
      },
    );

    await vi.waitFor(() => expect(children).toHaveLength(1));
    const firstAttempt = {
      role: "assistant",
      content: [{ type: "text", text: "primary failed" }],
      api: "test-api",
      provider: "test-provider",
      model: "test/primary",
      usage: {
        input: 5,
        output: 1,
        cacheRead: 2,
        cacheWrite: 0,
        totalTokens: 8,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
      },
      stopReason: "error",
      errorMessage: "primary failed",
      timestamp: 0,
    };
    emitPersistenceTestMessage(children[0], firstAttempt);
    children[0].stderr.emit("data", "No API key\n");
    children[0].emit("close", 1, null);

    await vi.waitFor(() => expect(children).toHaveLength(2));
    const fallbackAttempt = {
      ...firstAttempt,
      content: [{ type: "text", text: "fallback succeeded" }],
      model: "test/fallback",
      usage: {
        input: 7,
        output: 3,
        cacheRead: 1,
        cacheWrite: 2,
        totalTokens: 13,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.2 },
      },
      stopReason: "stop",
      errorMessage: undefined,
    };
    emitPersistenceTestMessage(children[1], fallbackAttempt);
    children[1].emit("close", 0, null);

    const result = await execution;

    expect(result.details?.results[0].usage).toMatchObject({
      input: 12,
      output: 4,
      cacheRead: 3,
      cacheWrite: 2,
      turns: 2,
    });
    expect(result.details?.results[0].usage.cost).toBeCloseTo(0.3);
    expect(result.details?.results[0].model).toBe("test/fallback");
    fs.rmSync(project, { recursive: true, force: true });
    vi.mocked(spawn).mockReset();
  });
});

describe("installAbortHandler", () => {
  it("escalates from SIGTERM to SIGKILL when the child has not closed", () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const signals: NodeJS.Signals[] = [];
      let closed = false;
      const cleanup = installAbortHandler({
        signal: controller.signal,
        process: {
          kill(signal: NodeJS.Signals) {
            signals.push(signal);
            return true;
          },
        },
        isClosed: () => closed,
        timeoutMs: 5000,
      });

      controller.abort();
      expect(signals).toEqual(["SIGTERM"]);
      vi.advanceTimersByTime(4999);
      expect(signals).toEqual(["SIGTERM"]);
      vi.advanceTimersByTime(1);
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not escalate after the child closes", () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const signals: NodeJS.Signals[] = [];
      let closed = false;
      const cleanup = installAbortHandler({
        signal: controller.signal,
        process: {
          kill(signal: NodeJS.Signals) {
            signals.push(signal);
            return true;
          },
        },
        isClosed: () => closed,
        timeoutMs: 5000,
      });

      controller.abort();
      closed = true;
      vi.advanceTimersByTime(5000);
      expect(signals).toEqual(["SIGTERM"]);
      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });
});
