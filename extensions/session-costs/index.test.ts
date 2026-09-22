import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { JsonValue, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  collectSessionUsage,
  executeSessionCostsCommand,
  formatSessionCosts,
  default as sessionCostsExtension,
} from "./index.js";

const usage = (values: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}): Usage => ({
  ...values,
  totalTokens: values.input + values.output + values.cacheRead + values.cacheWrite,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: values.cost,
  },
});

const subagentResult = (values: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  exitCode?: number;
  stopReason?: string;
}) => ({
  agent: "worker",
  agentSource: "user",
  task: "task",
  exitCode: values.exitCode ?? 0,
  ...(values.stopReason === undefined ? {} : { stopReason: values.stopReason }),
  messages: [],
  stderr: "",
  usage: {
    input: values.input,
    output: values.output,
    cacheRead: values.cacheRead,
    cacheWrite: values.cacheWrite,
    cost: values.cost,
    contextTokens: 0,
    turns: 1,
  },
});

const subagentEntry = (
  id: string,
  mode: "single" | "parallel" | "chain",
  results: JsonValue,
  topLevelUsage?: Usage,
): SessionEntry => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: {
    role: "toolResult",
    toolCallId: `${id}-call`,
    toolName: "agent",
    content: [],
    details: {
      usageVersion: 3,
      mode,
      agentScope: "user",
      projectAgentsDir: null,
      results,
    },
    usage: topLevelUsage,
    isError: false,
    timestamp: 0,
  },
});

describe("collectSessionUsage", () => {
  it("matches Pi's billed usage across all session entry types", () => {
    const entries = [
      {
        type: "message",
        id: "assistant",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [],
          api: "test-api",
          provider: "test-provider",
          model: "test-model",
          usage: usage({ input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: 0.5 }),
          stopReason: "stop",
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "tool",
        parentId: "assistant",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "tool-call",
          toolName: "bash",
          content: [],
          usage: usage({ input: 3, output: 2, cacheRead: 1, cacheWrite: 0, cost: 0.2 }),
          isError: false,
          timestamp: 1,
        },
      },
      {
        type: "compaction",
        id: "compaction",
        parentId: "tool",
        timestamp: "2026-01-01T00:00:02.000Z",
        summary: "summary",
        firstKeptEntryId: "tool",
        tokensBefore: 100,
        usage: usage({ input: 7, output: 1, cacheRead: 0, cacheWrite: 2, cost: 0.3 }),
      },
      {
        type: "branch_summary",
        id: "branch",
        parentId: "compaction",
        timestamp: "2026-01-01T00:00:03.000Z",
        fromId: "assistant",
        summary: "branch summary",
        usage: usage({ input: 5, output: 3, cacheRead: 4, cacheWrite: 1, cost: 0.4 }),
      },
      {
        type: "usage",
        id: "cache-warm",
        parentId: "branch",
        timestamp: "2026-01-01T00:00:04.000Z",
        kind: "cache_warm",
        provider: "test-provider",
        model: "test-model",
        usage: usage({ input: 6, output: 1, cacheRead: 5, cacheWrite: 0, cost: 0.6 }),
      },
    ] satisfies SessionEntry[];

    const report = collectSessionUsage(entries);

    expect(report.main).toEqual({
      input: 31,
      output: 11,
      cacheRead: 12,
      cacheWrite: 4,
      cost: 2.0,
    });
    expect(report.subagents).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    });
    expect(report.subagentRuns).toBe(0);
  });

  it("formats prompt, total, and cost values with clear labels", () => {
    const report = {
      main: { input: 10, output: 7, cacheRead: 20, cacheWrite: 5, cost: 1.23456 },
      subagents: { input: 3, output: 2, cacheRead: 4, cacheWrite: 1, cost: 1.23456 },
      subagentRuns: 2,
      warnings: [],
    };

    expect(formatSessionCosts(report)).toBe(
      "Session costs\n\n" +
        "Main agent\n" +
        "  Prompt: 35\n" +
        "  Cached: 20\n" +
        "  Cache writes: 5\n" +
        "  Output: 7\n" +
        "  Total: 42\n" +
        "  Cost: $1.2346\n\n" +
        "Subagents\n" +
        "  Runs: 2\n" +
        "  Prompt: 8\n" +
        "  Cached: 4\n" +
        "  Cache writes: 1\n" +
        "  Output: 2\n" +
        "  Total: 10\n" +
        "  Cost: $1.2346\n\n" +
        "Combined\n" +
        "  Total: 52 tokens\n" +
        "  Cost: $2.4691",
    );
  });

  it("registers session-costs without replacing Pi's session command", () => {
    type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
    const commands = new Map<string, CommandOptions>();
    const extension: Pick<ExtensionAPI, "registerCommand"> = {
      registerCommand(name, options) {
        commands.set(name, options);
      },
    };

    sessionCostsExtension(extension);

    expect(commands.has("session-costs")).toBe(true);
    expect(commands.has("session")).toBe(false);
    expect(commands.get("session-costs")?.description).toBe(
      "Show main-agent and subagent token and cost usage",
    );
  });

  it("notifies the formatted report from a minimal command context", () => {
    const notifications: Array<{ message: string; level?: string }> = [];
    executeSessionCostsCommand({
      sessionManager: { getEntries: () => [] },
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].level).toBe("info");
    expect(notifications[0].message).toContain("Session costs");
    expect(notifications[0].message).toContain("Combined");
  });

  it("counts recognized descendant usage without double counting top-level agent usage", () => {
    const report = collectSessionUsage([
      subagentEntry(
        "nested",
        "single",
        [
          {
            ...subagentResult({ input: 10, output: 1, cacheRead: 2, cacheWrite: 0, cost: 0.1 }),
            descendantUsage: {
              input: 2,
              output: 3,
              cacheRead: 1,
              cacheWrite: 1,
              cost: 0.2,
            },
            descendantRuns: 3,
          },
        ],
        usage({ input: 100, output: 100, cacheRead: 100, cacheWrite: 100, cost: 10 }),
      ),
    ]);

    expect(report.main).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    });
    expect(report.subagents).toMatchObject({
      input: 12,
      output: 4,
      cacheRead: 3,
      cacheWrite: 1,
    });
    expect(report.subagents.cost).toBeCloseTo(0.3);
    expect(report.subagentRuns).toBe(4);
    expect(report.warnings).toEqual([]);
  });

  it("counts direct usage once across single, parallel, and chain records", () => {
    const entries = [
      subagentEntry("single", "single", [
        subagentResult({ input: 10, output: 1, cacheRead: 2, cacheWrite: 3, cost: 0.1 }),
      ]),
      subagentEntry("parallel", "parallel", [
        subagentResult({
          input: 20,
          output: 2,
          cacheRead: 4,
          cacheWrite: 0,
          cost: 0.2,
          exitCode: 1,
        }),
        subagentResult({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
      ]),
      subagentEntry("chain", "chain", [
        subagentResult({
          input: 30,
          output: 4,
          cacheRead: 0,
          cacheWrite: 2,
          cost: 0.4,
          exitCode: 1,
          stopReason: "aborted",
        }),
      ]),
    ];

    const report = collectSessionUsage(entries);

    expect(report.subagents).toMatchObject({
      input: 60,
      output: 7,
      cacheRead: 6,
      cacheWrite: 5,
    });
    expect(report.subagents.cost).toBeCloseTo(0.7);
    expect(report.subagentRuns).toBe(4);
  });
});
