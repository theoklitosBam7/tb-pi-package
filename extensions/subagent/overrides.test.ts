import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "./agents.js";
import { getAgentOverride, loadAgentOverrides, resolveAgentOptions } from "./overrides.js";

const temporaryDirectories: string[] = [];

function createTemporaryAgentDir(): string {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-overrides-"));
  temporaryDirectories.push(agentDir);
  return agentDir;
}

function createAgentDir(settings: unknown): string {
  const agentDir = createTemporaryAgentDir();
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
  return agentDir;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadAgentOverrides", () => {
  it("loads a named agent override from the active agent directory", () => {
    const agentDir = createAgentDir({
      subagents: {
        agentOverrides: {
          researcher: {
            model: "openai-codex/gpt-5.6-luna",
            thinking: "medium",
            tools: ["read", "rg"],
            systemPrompt: "Use primary sources.",
          },
        },
      },
    });

    const snapshot = loadAgentOverrides({ agentDir });

    expect(getAgentOverride(snapshot, "researcher")).toEqual({
      kind: "valid",
      value: {
        model: "openai-codex/gpt-5.6-luna",
        thinking: "medium",
        tools: ["read", "rg"],
        systemPrompt: "Use primary sources.",
      },
    });
  });

  it.each([[], "read", ["read", " "], ["read", 2], ["read,write"]])(
    "rejects invalid tools lists (%j)",
    (tools) => {
      const agentDir = createAgentDir({
        subagents: { agentOverrides: { reviewer: { tools } } },
      });
      const settingsPath = path.join(agentDir, "settings.json");

      expect(getAgentOverride(loadAgentOverrides({ agentDir }), "reviewer")).toEqual({
        kind: "invalid",
        error: `${settingsPath}: subagents.agentOverrides.reviewer.tools must be a non-empty array of tool names without commas or surrounding whitespace.`,
      });
    },
  );

  it("isolates an unknown field error to its named agent", () => {
    const agentDir = createAgentDir({
      subagents: {
        agentOverrides: {
          reviewer: { temperature: 0.2 },
          researcher: { thinking: "high" },
        },
      },
    });

    const snapshot = loadAgentOverrides({ agentDir });

    expect(getAgentOverride(snapshot, "reviewer")).toEqual({
      kind: "invalid",
      error: `${path.join(agentDir, "settings.json")}: subagents.agentOverrides.reviewer.temperature is not supported.`,
    });
    expect(getAgentOverride(snapshot, "researcher")).toEqual({
      kind: "valid",
      value: { thinking: "high" },
    });
  });

  it("returns no overrides when settings.json is absent", () => {
    const snapshot = loadAgentOverrides({ agentDir: createTemporaryAgentDir() });

    expect(snapshot.entries.size).toBe(0);
  });

  it("loads a fresh snapshot after settings.json changes", () => {
    const agentDir = createAgentDir({
      subagents: { agentOverrides: { reviewer: { thinking: "low" } } },
    });
    const settingsPath = path.join(agentDir, "settings.json");
    const first = loadAgentOverrides({ agentDir });

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        subagents: { agentOverrides: { reviewer: { thinking: "high" } } },
      }),
    );
    const second = loadAgentOverrides({ agentDir });

    expect(getAgentOverride(first, "reviewer")).toEqual({
      kind: "valid",
      value: { thinking: "low" },
    });
    expect(getAgentOverride(second, "reviewer")).toEqual({
      kind: "valid",
      value: { thinking: "high" },
    });
  });

  it("allows unrelated subagent settings, an empty override, and an empty prompt", () => {
    const agentDir = createAgentDir({
      subagents: {
        futureOption: true,
        agentOverrides: {
          reviewer: {},
          researcher: { systemPrompt: "" },
        },
      },
    });

    const snapshot = loadAgentOverrides({ agentDir });
    expect(getAgentOverride(snapshot, "reviewer")).toEqual({ kind: "valid", value: {} });
    expect(getAgentOverride(snapshot, "researcher")).toEqual({
      kind: "valid",
      value: { systemPrompt: "" },
    });
  });

  it("reports the settings path when the global file is malformed", () => {
    const agentDir = createTemporaryAgentDir();
    const settingsPath = path.join(agentDir, "settings.json");
    fs.writeFileSync(settingsPath, "{ not-json");

    expect(() => loadAgentOverrides({ agentDir })).toThrow(
      `${settingsPath}: Unable to load subagent overrides because settings.json is not valid JSON.`,
    );
  });

  it("reports the settings path when the global file cannot be read", () => {
    const agentDir = createTemporaryAgentDir();
    const settingsPath = path.join(agentDir, "settings.json");
    fs.mkdirSync(settingsPath);

    expect(() => loadAgentOverrides({ agentDir })).toThrow(
      `${settingsPath}: Unable to load subagent overrides because settings.json could not be read.`,
    );
  });

  it("rejects a present non-object subagents section", () => {
    const agentDir = createAgentDir({ subagents: "invalid" });
    const settingsPath = path.join(agentDir, "settings.json");

    expect(() => loadAgentOverrides({ agentDir })).toThrow(
      `${settingsPath}: subagents must be an object.`,
    );
  });

  it("rejects a present non-object agentOverrides section", () => {
    const agentDir = createAgentDir({ subagents: { agentOverrides: [] } });
    const settingsPath = path.join(agentDir, "settings.json");

    expect(() => loadAgentOverrides({ agentDir })).toThrow(
      `${settingsPath}: subagents.agentOverrides must be an object.`,
    );
  });

  it("marks a non-object named override as invalid", () => {
    const agentDir = createAgentDir({
      subagents: { agentOverrides: { reviewer: "invalid" } },
    });
    const settingsPath = path.join(agentDir, "settings.json");

    expect(getAgentOverride(loadAgentOverrides({ agentDir }), "reviewer")).toEqual({
      kind: "invalid",
      error: `${settingsPath}: subagents.agentOverrides.reviewer must be an object.`,
    });
  });

  it("rejects a thinking level outside Pi's exact enum", () => {
    const agentDir = createAgentDir({
      subagents: { agentOverrides: { reviewer: { thinking: "HIGH" } } },
    });
    const settingsPath = path.join(agentDir, "settings.json");

    expect(getAgentOverride(loadAgentOverrides({ agentDir }), "reviewer")).toEqual({
      kind: "invalid",
      error: `${settingsPath}: subagents.agentOverrides.reviewer.thinking must be one of off, minimal, low, medium, high, xhigh, max.`,
    });
  });

  it("rejects a model with surrounding whitespace", () => {
    const agentDir = createAgentDir({
      subagents: { agentOverrides: { reviewer: { model: " openai/gpt-5 " } } },
    });
    const settingsPath = path.join(agentDir, "settings.json");

    expect(getAgentOverride(loadAgentOverrides({ agentDir }), "reviewer")).toEqual({
      kind: "invalid",
      error: `${settingsPath}: subagents.agentOverrides.reviewer.model must be a non-empty string without surrounding whitespace.`,
    });
  });

  it("rejects a non-string system prompt without exposing its value", () => {
    const agentDir = createAgentDir({
      subagents: { agentOverrides: { reviewer: { systemPrompt: { secret: "do not print" } } } },
    });
    const settingsPath = path.join(agentDir, "settings.json");

    expect(getAgentOverride(loadAgentOverrides({ agentDir }), "reviewer")).toEqual({
      kind: "invalid",
      error: `${settingsPath}: subagents.agentOverrides.reviewer.systemPrompt must be a string.`,
    });
  });
});

const reviewerAgent: AgentConfig = {
  name: "reviewer",
  description: "Reviews changes",
  model: "frontmatter/model",
  thinking: "low",
  tools: ["read", "rg"],
  systemPrompt: "Markdown prompt",
  source: "user",
  filePath: "/agents/reviewer.md",
};

describe("resolveAgentOptions", () => {
  it("applies tool, settings, frontmatter, and parent model precedence", () => {
    expect(
      resolveAgentOptions(
        reviewerAgent,
        {
          model: "settings/model",
          thinking: "xhigh",
          tools: ["write"],
          systemPrompt: "",
        },
        { modelOverride: "tool/model", parentModel: "parent/model" },
      ),
    ).toEqual({
      modelsToTry: ["tool/model", "settings/model", "frontmatter/model", "parent/model"],
      effectiveModel: "tool/model",
      effectiveModelSource: "tool",
      thinking: "xhigh",
      thinkingSource: "settings",
      tools: ["write"],
      systemPrompt: "",
      systemPromptOverridden: true,
    });
  });

  it("uses frontmatter thinking and tools when settings do not override them", () => {
    expect(resolveAgentOptions(reviewerAgent, undefined)).toMatchObject({
      thinking: "low",
      thinkingSource: "frontmatter",
      tools: ["read", "rg"],
    });
  });
});
