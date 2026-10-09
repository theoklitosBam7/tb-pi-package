import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runAcpTask, type AcpAgentConfig } from "./client.js";

const CONFIG = path.join(os.homedir(), ".pi", "agent", "acp-agents.json");
const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_ACTIVE = 2;
let active = 0;

function loadAgents(): Record<string, AcpAgentConfig> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(CONFIG);
  } catch (error: any) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("ACP config must be an owner-only regular file (chmod 600)");
  if (stat.size > 65536) throw new Error("ACP config too large");
  const parsed: unknown = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid ACP config");
  const agents: Record<string, AcpAgentConfig> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!NAME.test(name) || !value || typeof value !== "object")
      throw new Error("Invalid ACP agent entry");
    const entry = value as Record<string, unknown>;
    if (typeof entry.command !== "string" || !path.isAbsolute(entry.command) ||
        !Array.isArray(entry.args) || !entry.args.every(x => typeof x === "string"))
      throw new Error("ACP agents require an absolute executable path and string arguments");
    agents[name] = { command: entry.command, args: entry.args as string[] };
  }
  return agents;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "acp_agent",
    label: "ACP Agent",
    description: "Delegate a task to a named ACP v1 agent from the trusted user configuration. ACP agent permissions are denied by default.",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent name in ~/.pi/agent/acp-agents.json" }),
      task: Type.String({ description: "Task for the ACP agent", maxLength: 100000 }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const agents = loadAgents();
        if (!Object.hasOwn(agents, params.agent)) throw new Error("ACP agent is not configured");
        if (active >= MAX_ACTIVE) throw new Error("ACP agent concurrency limit reached");
        active++;
        try {
          const output = await runAcpTask(agents[params.agent], ctx.cwd, params.task, signal);
          return { content: [{ type: "text" as const, text: output || "(ACP agent returned no text)" }] };
        } finally {
          active--;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown ACP failure";
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    },
  });
  pi.registerCommand("acp", {
    description: "List configured ACP agents",
    handler: async (_args, ctx) => {
      try {
        const names = Object.keys(loadAgents());
        ctx.ui.notify(names.length ? `ACP agents: ${names.join(", ")}` : "No ACP agents configured.", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "ACP configuration error", "error");
      }
    },
  });
}
