import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
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
    };

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
    const result = {
      agent: "reviewer",
      agentSource: "user" as const,
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
    const result = {
      agent: "reviewer",
      agentSource: "user" as const,
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
    const result = {
      agent: "reviewer",
      agentSource: "user" as const,
      task: "Review",
      exitCode: 0,
      messages: [assistant("done")],
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

function registerPersistenceTestTools(): Record<string, any> {
  const tools: Record<string, any> = {};
  subagentExtension({
    on() {},
    registerTool(tool: any) {
      tools[tool.name] = tool;
    },
    registerCommand() {},
    registerShortcut() {},
  } as any);
  return tools;
}

describe("nested usage persistence", () => {
  it("captures nested agent usage before artifact persistence clears messages", async () => {
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
    child.stdout.emit(
      "data",
      `${JSON.stringify({ type: "message_end", message: assistantMessage })}\n`,
    );
    child.stdout.emit(
      "data",
      `${JSON.stringify({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "nested-call",
          toolName: "agent",
          content: [],
          details: nestedDetails,
          isError: false,
          timestamp: 1,
        },
      })}\n`,
    );
    child.emit("close", 0, null);

    const result = await execution;

    expect(result.details?.results[0].descendantUsage).toEqual({
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      cost: 0.2,
    });
    expect(result.details?.usageVersion).toBe(2);
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
    children[0].stdout.emit(
      "data",
      `${JSON.stringify({ type: "message_end", message: firstAttempt })}\n`,
    );
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
    children[1].stdout.emit(
      "data",
      `${JSON.stringify({ type: "message_end", message: fallbackAttempt })}\n`,
    );
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
