import { describe, expect, it } from "vitest";
import { buildAgentListResponse, createAgentDefinition } from "../list-agents.js";
import type { AgentConfig } from "./agents.js";
import type { AgentOverrideEntry } from "./overrides.js";

const reviewer: AgentConfig = {
  name: "reviewer",
  description: "Reviews changes",
  model: "frontmatter/model",
  subagentType: "review",
  tools: ["read", "rg"],
  systemPrompt: "Markdown agent prompt",
  source: "user",
  filePath: "/agents/reviewer.md",
};

describe("agent override listing", () => {
  it("shows safe effective settings without exposing the override prompt", () => {
    const entry: AgentOverrideEntry = {
      kind: "valid",
      value: {
        model: "settings/model",
        thinking: "high",
        tools: ["write"],
        systemPrompt: "PRIVATE OVERRIDE PROMPT",
      },
    };

    const definition = createAgentDefinition(reviewer, entry, "parent/model");
    const text = buildAgentListResponse([definition]);

    expect(definition).toMatchObject({
      model: "frontmatter/model",
      effectiveModel: "settings/model",
      effectiveModelSource: "settings",
      thinking: "high",
      thinkingSource: "settings",
      tools: ["write"],
      systemPromptOverridden: true,
      content: "Markdown agent prompt",
    });
    expect(text).toContain("**Model:** settings/model (settings)");
    expect(text).toContain("**Tools:** write");
    expect(text).toContain("**Thinking:** high (settings)");
    expect(text).toContain("**System prompt:** overridden by settings");
    expect(JSON.stringify(definition)).not.toContain("PRIVATE OVERRIDE PROMPT");
    expect(text).not.toContain("PRIVATE OVERRIDE PROMPT");
  });

  it("shows frontmatter thinking with its source", () => {
    const frontmatterReviewer: AgentConfig = { ...reviewer, thinking: "low" };
    const definition = createAgentDefinition(frontmatterReviewer, undefined, "parent/model");
    const text = buildAgentListResponse([definition]);

    expect(definition).toMatchObject({ thinking: "low", thinkingSource: "frontmatter" });
    expect(text).toContain("**Thinking:** low (frontmatter)");
  });

  it("shows Pi default tools when the agent has no tools list", () => {
    const agentWithoutTools: AgentConfig = { ...reviewer, tools: undefined };
    const definition = createAgentDefinition(agentWithoutTools, undefined, "parent/model");
    const text = buildAgentListResponse([definition]);

    expect(definition.tools).toBeUndefined();
    expect(text).toContain("- **Tools:** Pi default");
  });

  it("shows an agent frontmatter configuration error", () => {
    const configError = "/agents/reviewer.md: thinking must use a supported level.";
    const invalidReviewer = { ...reviewer, configError };
    const definition = createAgentDefinition(invalidReviewer, undefined, "parent/model");
    const text = buildAgentListResponse([definition]);

    expect(definition.configError).toBe(configError);
    expect(text).toContain(`**Configuration error:** ${configError}`);
  });

  it("keeps valid agents visible when another agent has an invalid override", () => {
    const invalidEntry: AgentOverrideEntry = {
      kind: "invalid",
      error: "/agent/settings.json: subagents.agentOverrides.reviewer.thinking is invalid.",
    };
    const invalidReviewer = createAgentDefinition(reviewer, invalidEntry, "parent/model");
    const validResearcher = createAgentDefinition(
      { ...reviewer, name: "researcher", description: "Researches APIs" },
      undefined,
      "parent/model",
    );

    const text = buildAgentListResponse([invalidReviewer, validResearcher]);

    expect(text).toContain("### reviewer");
    expect(text).toContain("**Configuration error:** /agent/settings.json");
    expect(text).toContain("### researcher");
    expect(validResearcher.thinking).toBeUndefined();
    expect(text).toContain("**Thinking:** Pi default");
  });
});
