/**
 * List Agents Extension
 *
 * Lists ALL available agents from user (~/.pi/agent/agents/) and
 * project (.pi/agents) directories.
 * These are agent definitions with frontmatter (name, description, tools, model).
 *
 * Usage:
 * 1. Place this file in ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /agents to browse available agents interactively
 * 3. Or let the LLM call the list_agents tool
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig } from "./subagent/agents.js";

/**
 * Agent definition for display
 */
interface AgentDefinition {
  name: string;
  description?: string;
  tools?: string[];
  model?: string;
  subagentType?: string;
  path: string;
  content: string;
  source: string;
}

/**
 * Convert AgentConfig from discoverAgents to AgentDefinition.
 */
function agentConfigToDefinition(agent: AgentConfig): AgentDefinition {
  return {
    name: agent.name,
    description: agent.description,
    tools: agent.tools,
    model: agent.model,
    subagentType: agent.subagentType,
    path: agent.filePath,
    content: agent.systemPrompt,
    source: agent.source,
  };
}

/**
 * Discover agents from all sources: user and project.
 */
async function loadAllAgents(cwd: string): Promise<AgentDefinition[]> {
  const discovery = discoverAgents(cwd, "both");
  return discovery.agents.map(agentConfigToDefinition);
}

/**
 * Format agent info for display
 */
function formatAgent(agent: AgentDefinition): string {
  const lines: string[] = [];

  lines.push(`## ${agent.name}`);

  if (agent.description) {
    lines.push(agent.description);
  }

  if (agent.subagentType) {
    lines.push(`\n**Type:** ${agent.subagentType}`);
  }

  if (agent.tools && agent.tools.length > 0) {
    lines.push(`\n**Tools:** ${agent.tools.join(", ")}`);
  }

  if (agent.model) {
    lines.push(`**Model:** ${agent.model}`);
  }

  lines.push(`\n**Source:** ${agent.source}`);
  lines.push(`**Path:** ${agent.path}`);

  return lines.join("\n");
}

/**
 * Format a single agent for list display
 */
function formatAgentItem(agent: AgentDefinition): string {
  const desc = agent.description
    ? ` - ${agent.description.slice(0, 50)}${agent.description.length > 50 ? "..." : ""}`
    : "";
  const tools = agent.tools ? ` [${agent.tools.length} tools]` : "";
  return `${agent.name}${tools}${desc}`;
}

/**
 * Build agent list response text
 */
function buildAgentListResponse(agents: AgentDefinition[]): string {
  if (agents.length === 0) {
    return "No agents found.";
  }

  const userAgents = agents.filter((a) => a.source === "user");
  const projectAgents = agents.filter((a) => a.source === "project");

  const lines: string[] = [];
  lines.push(`# Available Agents (${agents.length} total)\n`);

  if (userAgents.length > 0) {
    lines.push(`## User Agents (~/.pi/agent/agents/)\n`);
    for (const agent of userAgents) {
      formatAgentEntry(lines, agent);
    }
  }

  if (projectAgents.length > 0) {
    lines.push(`## Project Agents (.pi/agents/)\n`);
    for (const agent of projectAgents) {
      formatAgentEntry(lines, agent);
    }
  }

  return lines.join("\n");
}

function formatAgentEntry(lines: string[], agent: AgentDefinition): void {
  lines.push(`### ${agent.name}`);
  if (agent.description) {
    lines.push(agent.description);
  }
  if (agent.subagentType) {
    lines.push(`- **Type:** ${agent.subagentType}`);
  }
  if (agent.tools && agent.tools.length > 0) {
    lines.push(`- **Tools:** ${agent.tools.join(", ")}`);
  }
  if (agent.model) {
    lines.push(`- **Model:** ${agent.model}`);
  }
  lines.push("");
}

/**
 * Main extension function
 */
export default function listAgentsExtension(pi: ExtensionAPI) {
  // Register the list_agents tool
  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description:
      "List ALL available agents from user (~/.pi/agent/agents/), project (.pi/agents), " +
      "These are agent definitions with specialized capabilities (planner, reviewer, scout, worker, etc.). " +
      "Use this tool when you need to delegate work to a specialized agent.",
    promptSnippet: "List all available pi coding agent agents",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const agents = await loadAllAgents(ctx.cwd);

      if (agents.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No agents found.",
            },
          ],
          details: { count: 0, agents: [] },
        };
      }

      const responseText = buildAgentListResponse(agents);

      return {
        content: [{ type: "text", text: responseText }],
        details: {
          count: agents.length,
          agents: agents.map((a) => ({
            name: a.name,
            description: a.description,
            subagentType: a.subagentType,
            tools: a.tools,
            model: a.model,
            path: a.path,
            source: a.source,
          })),
        },
      };
    },
  });

  // Register the /agents command for interactive use
  pi.registerCommand("agents", {
    description: "List ALL available agents",
    handler: async (_args, ctx) => {
      const agents = await loadAllAgents(ctx.cwd);

      if (agents.length === 0) {
        ctx.ui.notify("No agents found.", "info");
        return;
      }

      // Build list items grouped by source
      const items: string[] = [];
      items.push(`--- All Agents (${agents.length}) ---`);

      const userAgents = agents.filter((a) => a.source === "user");
      const projectAgents = agents.filter((a) => a.source === "project");

      if (userAgents.length > 0) {
        items.push(`-- User (${userAgents.length}) --`);
        for (const agent of userAgents) items.push(formatAgentItem(agent));
      }
      if (projectAgents.length > 0) {
        items.push(`-- Project (${projectAgents.length}) --`);
        for (const agent of projectAgents) items.push(formatAgentItem(agent));
      }

      // Show selector
      const selected = await ctx.ui.select("Available Agents", items);

      if (!selected || selected.startsWith("---") || selected.startsWith("--")) {
        return;
      }

      // Show details for selected agent
      const agentName = selected.split(" ")[0];
      const agent = agents.find((a) => a.name === agentName);

      if (agent) {
        const detailLines = formatAgent(agent).split("\n");

        const action = await ctx.ui.select(`${agent.name}`, [
          ...detailLines,
          "---",
          "View full content",
          "Dismiss",
        ]);

        if (action === "View full content") {
          ctx.ui.setEditorText(agent.content.slice(0, 2000));
        }
      }
    },
  });
}
