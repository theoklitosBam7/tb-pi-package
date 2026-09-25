import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  parseSubagentThinkingLevel,
  type AgentConfig,
  type SubagentThinkingLevel,
} from "./agents.js";

type NonEmptyToolList = [string, ...string[]];

export interface AgentOverride {
  model?: string;
  thinking?: SubagentThinkingLevel;
  tools?: NonEmptyToolList;
  systemPrompt?: string;
}

export type AgentOverrideEntry =
  | { kind: "valid"; value: AgentOverride }
  | { kind: "invalid"; error: string };

export interface AgentOverridesSnapshot {
  settingsPath: string;
  entries: ReadonlyMap<string, AgentOverrideEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyToolList(value: unknown): value is NonEmptyToolList {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (tool: unknown) =>
        typeof tool === "string" && tool.length > 0 && tool.trim() === tool && !tool.includes(","),
    )
  );
}

const AGENT_OVERRIDE_FIELDS = new Set(["model", "thinking", "tools", "systemPrompt"]);

function parseAgentOverride(
  settingsPath: string,
  agentName: string,
  value: unknown,
): AgentOverrideEntry {
  const fieldPath = `subagents.agentOverrides.${agentName}`;
  if (!isRecord(value)) {
    return {
      kind: "invalid",
      error: `${settingsPath}: ${fieldPath} must be an object.`,
    };
  }

  const unsupportedField = Object.keys(value).find((field) => !AGENT_OVERRIDE_FIELDS.has(field));
  if (unsupportedField !== undefined) {
    return {
      kind: "invalid",
      error: `${settingsPath}: ${fieldPath}.${unsupportedField} is not supported.`,
    };
  }

  const override: AgentOverride = {};
  if (value.model !== undefined) {
    if (
      typeof value.model !== "string" ||
      value.model.length === 0 ||
      value.model.trim() !== value.model
    ) {
      return {
        kind: "invalid",
        error: `${settingsPath}: ${fieldPath}.model must be a non-empty string without surrounding whitespace.`,
      };
    }
    override.model = value.model;
  }

  if (value.thinking !== undefined) {
    const thinking = parseSubagentThinkingLevel(value.thinking);
    if (thinking === undefined) {
      return {
        kind: "invalid",
        error: `${settingsPath}: ${fieldPath}.thinking must be one of off, minimal, low, medium, high, xhigh, max.`,
      };
    }
    override.thinking = thinking;
  }

  if (value.tools !== undefined) {
    if (!isNonEmptyToolList(value.tools)) {
      return {
        kind: "invalid",
        error: `${settingsPath}: ${fieldPath}.tools must be a non-empty array of tool names without commas or surrounding whitespace.`,
      };
    }
    override.tools = value.tools;
  }

  if (value.systemPrompt !== undefined) {
    if (typeof value.systemPrompt !== "string") {
      return {
        kind: "invalid",
        error: `${settingsPath}: ${fieldPath}.systemPrompt must be a string.`,
      };
    }
    override.systemPrompt = value.systemPrompt;
  }

  return { kind: "valid", value: override };
}

export function loadAgentOverrides(options: { agentDir?: string } = {}): AgentOverridesSnapshot {
  const settingsPath = path.join(options.agentDir ?? getAgentDir(), "settings.json");
  if (!fs.existsSync(settingsPath)) {
    return { settingsPath, entries: new Map() };
  }

  let content: string;
  try {
    content = fs.readFileSync(settingsPath, "utf-8");
  } catch {
    throw new Error(
      `${settingsPath}: Unable to load subagent overrides because settings.json could not be read.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      `${settingsPath}: Unable to load subagent overrides because settings.json is not valid JSON.`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`${settingsPath}: settings.json must contain an object.`);
  }
  if (parsed.subagents === undefined) {
    return { settingsPath, entries: new Map() };
  }
  if (!isRecord(parsed.subagents)) {
    throw new Error(`${settingsPath}: subagents must be an object.`);
  }

  const rawOverrides = parsed.subagents.agentOverrides;
  if (rawOverrides === undefined) {
    return { settingsPath, entries: new Map() };
  }
  if (!isRecord(rawOverrides)) {
    throw new Error(`${settingsPath}: subagents.agentOverrides must be an object.`);
  }

  const entries = new Map<string, AgentOverrideEntry>();
  for (const [agentName, value] of Object.entries(rawOverrides)) {
    entries.set(agentName, parseAgentOverride(settingsPath, agentName, value));
  }

  return { settingsPath, entries };
}

export function getAgentOverride(
  snapshot: AgentOverridesSnapshot,
  agentName: string,
): AgentOverrideEntry | undefined {
  return snapshot.entries.get(agentName);
}

export function getAgentConfigurationError(
  agent: AgentConfig,
  overrideEntry: AgentOverrideEntry | undefined,
): string | undefined {
  const errors = [
    agent.configError,
    overrideEntry?.kind === "invalid" ? overrideEntry.error : undefined,
  ].filter((error): error is string => error !== undefined);
  return errors.length > 0 ? errors.join("; ") : undefined;
}

export type EffectiveModelSource = "tool" | "settings" | "frontmatter" | "parent" | "default";

export interface ResolvedAgentOptions {
  modelsToTry: Array<string | undefined>;
  effectiveModel?: string;
  effectiveModelSource: EffectiveModelSource;
  thinking?: SubagentThinkingLevel;
  thinkingSource?: "settings" | "frontmatter";
  tools?: string[];
  systemPrompt: string;
  systemPromptOverridden: boolean;
}

export function resolveAgentOptions(
  agent: AgentConfig,
  override: AgentOverride | undefined,
  options: { modelOverride?: string; parentModel?: string } = {},
): ResolvedAgentOptions {
  const candidates: Array<{ model: string | undefined; source: EffectiveModelSource }> = [
    { model: options.modelOverride, source: "tool" },
    { model: override?.model, source: "settings" },
    { model: agent.model, source: "frontmatter" },
    { model: options.parentModel, source: "parent" },
  ];
  const modelsToTry: Array<string | undefined> = [];
  let effectiveModel: string | undefined;
  let effectiveModelSource: EffectiveModelSource = "default";

  for (const candidate of candidates) {
    if (candidate.model === undefined || modelsToTry.includes(candidate.model)) continue;
    if (effectiveModel === undefined) {
      effectiveModel = candidate.model;
      effectiveModelSource = candidate.source;
    }
    modelsToTry.push(candidate.model);
  }
  if (modelsToTry.length === 0) modelsToTry.push(undefined);

  const systemPromptOverridden = override?.systemPrompt !== undefined;
  const thinking = override?.thinking ?? agent.thinking;
  const thinkingSource =
    override?.thinking !== undefined
      ? "settings"
      : agent.thinking !== undefined
        ? "frontmatter"
        : undefined;
  return {
    modelsToTry,
    effectiveModel,
    effectiveModelSource,
    thinking,
    thinkingSource,
    tools: override?.tools ?? agent.tools,
    systemPrompt: systemPromptOverridden ? override.systemPrompt : agent.systemPrompt,
    systemPromptOverridden,
  };
}
