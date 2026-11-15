import { describe, expect, it } from "vitest";
import type { RunSnapshot } from "./run-manager.js";
import {
  formatCancelReport,
  formatLaunchReport,
  formatRunState,
  formatSendReport,
  formatStatusCard,
  formatStatusList,
  formatTerminalReport,
  formatUsage,
  MAX_STATUS_CHARS,
  sanitizeText,
  shortPath,
  shortRunId,
  toRunSummary,
} from "./presentation.js";

const COMPLETED_RUN_ID = "1063e371-3864-4f21-91d9-1e47886f4236";
const RUNNING_RUN_ID = "54d1769e-0f64-4e57-8ff1-7b0c9a2e5d11";
const ARTIFACT_PATH =
  "/home/tester/.pi/agent/sessions/--home-tester-dev-example-project--/2026-11-07T15-57-58-591Z_01a1b6bb/2026-11-07T15-57-58-591Z_01a1b6bb-call_5195-single-generalist.md";

const usage = {
  input: 52_340,
  output: 6_120,
  cacheRead: 326_000,
  cacheWrite: 0,
  cost: 0.0115,
  contextTokens: 58_460,
  turns: 13,
};

function completedRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: COMPLETED_RUN_ID,
    agent: "generalist",
    task: "Implement documentation phase 7 only.",
    state: {
      kind: "completed",
      result: {
        status: "completed",
        artifactPath: ARTIFACT_PATH,
        value: {
          usage,
          messages: [],
          displayItems: [{ type: "toolCall", name: "read", args: { path: "/tmp/input.ts" } }],
          modelProvenance: {
            requested: "inherit",
            resolved: [],
            attempted: [],
            dispatch: [],
            response: [],
          },
          preview: "Documentation phase 7 is complete.",
        },
      },
    },
    reports: ["Discovery complete: the repo has a mature inspector store."],
    messages: [
      {
        id: "message-1",
        content: "Include the token refresh path",
        mode: "steer",
        outcome: "accepted-by-child",
      },
    ],
    ...overrides,
  };
}

function runningRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: RUNNING_RUN_ID,
    agent: "implementer",
    task: "Implement phase 5 lifecycle wiring only.",
    state: { kind: "running" },
    reports: ["Reading the lifecycle module.", "Wiring the queued state."],
    messages: [],
    ...overrides,
  };
}

describe("shortRunId", () => {
  it("keeps the first eight characters of a run UUID", () => {
    expect(shortRunId(COMPLETED_RUN_ID)).toBe("1063e371");
  });

  it("leaves a short identifier unchanged", () => {
    expect(shortRunId("run-1")).toBe("run-1");
  });
});

describe("shortPath", () => {
  it("uses a tilde for the home directory", () => {
    expect(shortPath("/opt/pi/agent/sessions/a.md", { home: "/home/tester" })).toBe(
      "/opt/pi/agent/sessions/a.md",
    );
    expect(shortPath("/home/tester/.pi/agent/sessions/a.md", { home: "/home/tester" })).toBe(
      "~/.pi/agent/sessions/a.md",
    );
  });

  it("elides the middle of a long path within the width limit", () => {
    const shortened = shortPath(ARTIFACT_PATH, { home: "/home/tester", maxWidth: 48 });
    expect(shortened.length).toBeLessThanOrEqual(48);
    expect(shortened.startsWith("~/.pi/")).toBe(true);
    expect(shortened.endsWith(".md")).toBe(true);
    expect(shortened).toContain("...");
  });

  it("keeps a path that already fits", () => {
    expect(shortPath("~/.pi/a.md", { home: "/home/tester", maxWidth: 48 })).toBe("~/.pi/a.md");
  });
});

describe("sanitizeText", () => {
  it("removes ANSI escapes and control characters but keeps line breaks", () => {
    const text = sanitizeText("\u001b[31mred\u001b[0m\u0007 line\nnext\tcell");
    expect(text).toBe("red line\nnext\tcell");
  });
});

describe("formatRunState", () => {
  it.each([
    ["completed", "✓ completed"],
    ["running", "⏳ running"],
    ["timed out", "✗ timed out"],
    ["failed", "✗ failed"],
    ["aborted", "■ aborted"],
  ])("labels %s with a status marker", (status, expected) => {
    expect(formatRunState(status as never)).toBe(expected);
  });
});

describe("formatUsage", () => {
  it("renders turns, tokens, cache reads, and cost compactly", () => {
    expect(formatUsage(usage)).toBe("13 turns ↑52k ↓6.1k R326k $0.0115");
  });

  it("returns an empty string when there is no usage", () => {
    expect(
      formatUsage({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      }),
    ).toBe("");
  });
});

describe("toRunSummary", () => {
  it("drops child tool history and model provenance", () => {
    const summary = toRunSummary(completedRun());
    expect(summary.status).toBe("completed");
    expect(summary.artifactPath).toBe(ARTIFACT_PATH);
    expect(summary.usage).toMatchObject({ turns: 13, cost: 0.0115 });
    expect(summary.preview).toBe("Documentation phase 7 is complete.");
    expect(JSON.stringify(summary)).not.toContain("displayItems");
    expect(JSON.stringify(summary)).not.toContain("modelProvenance");
    expect(JSON.stringify(summary)).not.toContain("toolCall");
  });

  it("reports the active state of a running run", () => {
    const summary = toRunSummary(runningRun());
    expect(summary.status).toBe("running");
    expect(summary.artifactPath).toBeUndefined();
    expect(summary.reportCount).toBe(2);
  });

  it("caps stored report text and records how many reports exist", () => {
    const longReports = Array.from({ length: 20 }, () => "x".repeat(1_000));
    const summary = toRunSummary(runningRun({ reports: longReports }));
    expect(summary.reportCount).toBe(20);
    expect(summary.reports.length).toBeLessThan(20);
    expect(summary.reports.join("").length).toBeLessThanOrEqual(2_000);
  });
});

describe("formatStatusList", () => {
  it("lists the full run ID, state, task, and artifact path", () => {
    const text = formatStatusList([toRunSummary(completedRun()), toRunSummary(runningRun())]);
    expect(text).toContain(COMPLETED_RUN_ID);
    expect(text).toContain(RUNNING_RUN_ID);
    expect(text).toContain("✓ completed");
    expect(text).toContain("⏳ running");
    expect(text).toContain("Implement documentation phase 7 only.");
    expect(text).toContain(ARTIFACT_PATH);
    expect(text).toContain("2 reports");
  });

  it("does not leak the transport payload", () => {
    const text = formatStatusList([toRunSummary(completedRun())]);
    expect(text).not.toContain("displayItems");
    expect(text).not.toContain("modelProvenance");
    expect(text).not.toContain('"value"');
  });

  it("keeps a fourteen-run report within the cap", () => {
    const runs = Array.from({ length: 14 }, (_, index) =>
      toRunSummary(
        completedRun({
          id: `${index.toString(16).padStart(8, "0")}-3864-4f21-91d9-1e47886f4236`,
          task: "Implement documentation phase 7 only. ".repeat(10),
          reports: Array.from({ length: 20 }, () => "Report text ".repeat(100)),
        }),
      ),
    );
    const text = formatStatusList(runs);
    expect(text.length).toBeLessThanOrEqual(MAX_STATUS_CHARS);
    expect(text).toContain("more runs omitted");
  });

  it("states clearly when there are no runs", () => {
    expect(formatStatusList([])).toBe("No asynchronous runs in this session.");
  });
});

describe("formatStatusCard", () => {
  it("shows the run fields, reports, and message outcomes", () => {
    const text = formatStatusCard(toRunSummary(completedRun()));
    expect(text).toContain(COMPLETED_RUN_ID);
    expect(text).toContain("Agent: generalist");
    expect(text).toContain("State: ✓ completed");
    expect(text).toContain("Artifact: " + ARTIFACT_PATH);
    expect(text).toContain("Reports (1):");
    expect(text).toContain("Discovery complete");
    expect(text).toContain("message-1 steer accepted-by-child");
  });

  it("describes a running run without an artifact", () => {
    const text = formatStatusCard(toRunSummary(runningRun()));
    expect(text).toContain("State: ⏳ running");
    expect(text).toContain("Artifact: none yet");
  });
});

describe("formatLaunchReport", () => {
  it("lists each started run once and tells the parent how to check progress", () => {
    const text = formatLaunchReport([toRunSummary(runningRun()), toRunSummary(completedRun())]);
    expect(text).toContain("Started 2 asynchronous runs.");
    expect(text).toContain(`- implementer: ${RUNNING_RUN_ID} (running)`);
    expect(text).toContain(`- generalist: ${COMPLETED_RUN_ID} (completed)`);
    expect(text).toContain("Use agent_status to check progress.");
  });
});

describe("formatSendReport", () => {
  it("reports an accepted message", () => {
    expect(
      formatSendReport({
        runId: "1063e371-3864-4f21-91d9-1e47886f4236",
        mode: "steer",
        result: { kind: "accepted", messageId: "message-3", outcome: "pending" },
      }),
    ).toBe(
      "Message message-3 accepted (steer → 1063e371-3864-4f21-91d9-1e47886f4236). Delivery is pending.",
    );
  });

  it("explains a rejection reason", () => {
    expect(
      formatSendReport({
        runId: "1063e371-3864-4f21-91d9-1e47886f4236",
        mode: "follow_up",
        result: { kind: "rejected", reason: "terminal" },
      }),
    ).toBe("Message rejected: run 1063e371-3864-4f21-91d9-1e47886f4236 is already terminal.");
  });
});

describe("formatCancelReport", () => {
  it("reports a successful cancellation", () => {
    expect(formatCancelReport("1063e371-3864-4f21-91d9-1e47886f4236", true)).toBe(
      "Run 1063e371-3864-4f21-91d9-1e47886f4236 canceled.",
    );
  });

  it("reports a cancellation that did not apply", () => {
    expect(formatCancelReport("1063e371-3864-4f21-91d9-1e47886f4236", false)).toBe(
      "Run 1063e371-3864-4f21-91d9-1e47886f4236 could not be canceled: not found or already terminal.",
    );
  });
});

describe("formatTerminalReport", () => {
  it("names the run ID once and includes the artifact, usage, and other-run counts", () => {
    const text = formatTerminalReport({
      run: toRunSummary(completedRun()),
      otherRuns: { active: 3, completed: 11, failed: 0 },
    });
    expect(text.match(new RegExp(COMPLETED_RUN_ID, "g"))?.length).toBe(1);
    expect(text).toContain("Subagent generalist completed");
    expect(text).toContain("Artifact: " + ARTIFACT_PATH);
    expect(text).toContain("13 turns");
    expect(text).toContain("Other runs: 3 active, 11 completed");
  });

  it("omits the other-run line when the run is the only one", () => {
    const text = formatTerminalReport({
      run: toRunSummary(completedRun()),
      otherRuns: { active: 0, completed: 0, failed: 0 },
    });
    expect(text).not.toContain("Other runs:");
  });
});

describe("formatTerminalReport failure safety", () => {
  it("does not repeat a failure message that embeds the artifact path", () => {
    const run = {
      ...toRunSummary(completedRun()),
      status: "failed" as const,
      artifactPath: undefined,
      error: `Unable to write subagent artifact ${ARTIFACT_PATH}: EISDIR`,
    };
    const text = formatTerminalReport({
      run,
      otherRuns: { active: 0, completed: 0, failed: 1 },
    });
    expect(text).not.toContain(ARTIFACT_PATH);
    expect(text).toContain("failed");
  });
});

describe("compact status formatting", () => {
  it("shortens run IDs and paths for the transcript but not for the model", () => {
    const summary = toRunSummary(completedRun());
    const forModel = formatStatusList([summary]);
    const forDisplay = formatStatusList([summary], { compact: true });

    expect(forModel).toContain(COMPLETED_RUN_ID);
    expect(forModel).toContain(ARTIFACT_PATH);
    expect(forDisplay).not.toContain(COMPLETED_RUN_ID);
    expect(forDisplay).toContain("1063e371");
    expect(forDisplay).not.toContain(ARTIFACT_PATH);
  });

  it("shortens the run ID and path in a single run card", () => {
    const summary = toRunSummary(completedRun());
    const forDisplay = formatStatusCard(summary, { compact: true });
    expect(forDisplay).toContain("agent_status: 1063e371");
    expect(forDisplay).not.toContain(ARTIFACT_PATH);
  });
});
