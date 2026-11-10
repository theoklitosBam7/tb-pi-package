import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents } from "./agents.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("discoverAgents", () => {
  it("loads a thinking level from agent frontmatter", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agents-"));
    temporaryDirectories.push(cwd);
    const agentsDir = path.join(cwd, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews changes\nthinking: high\n---\nReview carefully.\n",
    );

    const result = discoverAgents(cwd, "project");

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({ name: "reviewer", thinking: "high" });
  });

  it("records an invalid thinking level as an agent configuration error", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agents-"));
    temporaryDirectories.push(cwd);
    const agentsDir = path.join(cwd, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews changes\nthinking: HIGH\n---\nReview carefully.\n",
    );

    const result = discoverAgents(cwd, "project");
    const agent = result.agents[0];

    expect(agent).toMatchObject({
      name: "reviewer",
      configError: `${agent.filePath}: thinking must be one of off, minimal, low, medium, high, xhigh, max.`,
    });
  });
});
