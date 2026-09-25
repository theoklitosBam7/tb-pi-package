import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import listAgentsExtension, {
  buildAgentListResponse,
  createAgentDefinition,
} from "../list-agents.js";
import type { AgentConfig } from "./agents.js";
import type { AgentOverrideEntry } from "./overrides.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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

  it("shows frontmatter and override errors together", () => {
    const frontmatterError = "/agents/reviewer.md: thinking must use a supported level.";
    const overrideError =
      "/agent/settings.json: subagents.agentOverrides.reviewer.tools is invalid.";
    const invalidEntry: AgentOverrideEntry = { kind: "invalid", error: overrideError };
    const invalidReviewer = createAgentDefinition(
      { ...reviewer, configError: frontmatterError },
      invalidEntry,
      "parent/model",
    );

    const text = buildAgentListResponse([invalidReviewer]);

    expect(text).toContain(`**Configuration error:** ${frontmatterError}; ${overrideError}`);
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

describe("/agents command", () => {
  it("shows an invalid agent's configuration error in the chooser", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-list-agents-"));
    temporaryDirectories.push(cwd);
    vi.stubEnv("PI_CODING_AGENT_DIR", cwd);

    const agentsDir = path.join(cwd, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "worker.md"),
      "---\nname: worker\ndescription: Test worker\nthinking: HIGH\n---\n",
    );

    type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
    const commands = new Map<string, CommandOptions>();
    listAgentsExtension({
      registerTool() {},
      registerCommand(name: string, options: CommandOptions) {
        commands.set(name, options);
      },
    } as unknown as ExtensionAPI);

    let chooserItems: string[] = [];
    const context = {
      cwd,
      model: undefined,
      ui: {
        async select(title: string, items: string[]) {
          if (title === "Available Agents") chooserItems = items;
          return undefined;
        },
        notify() {},
        setEditorText() {},
      },
    } as unknown as Parameters<CommandOptions["handler"]>[1];

    await commands.get("agents")?.handler("", context);

    const workerError = `${path.join(agentsDir, "worker.md")}: thinking must be one of`;
    expect(
      chooserItems.some((item) => item.startsWith("worker ") && item.includes(workerError)),
    ).toBe(true);
  });
});
