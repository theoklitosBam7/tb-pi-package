/**
 * Agent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each agent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from agents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
  getPackageDir,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  addUsageTotals,
  addUsageTotalsWithTurns,
  createUsageTotals,
  createUsageTotalsWithTurns,
  getPersistedSubagentUsage,
  hasUsageTotals,
  parsePiUsage,
  type PersistedSubagentDetails,
} from "../lib/usage.js";
import {
  type AgentConfig,
  type AgentScope,
  type SubagentThinkingLevel,
  discoverAgents,
  formatAgentList,
} from "./agents.js";
import {
  AgentInspectorComponent,
  AgentInspectorStore,
  getInspectorMessageText,
  getInspectorText,
} from "./inspector.js";
import {
  type AgentOverridesSnapshot,
  getAgentConfigurationError,
  getAgentOverride,
  loadAgentOverrides,
  resolveAgentOptions,
} from "./overrides.js";
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
  type ResultThinking,
  type SingleResult,
  type WatchdogTermination,
  writeResultArtifact,
} from "./result.js";

/**
 * Find an agent by its subagent_type.
 * Returns the first match (order depends on filesystem directory listing).
 * If multiple agents share the same type, the first one loaded wins.
 */
function findAgentByType(agents: AgentConfig[], type: string): AgentConfig | undefined {
  return agents.find((a) => a.subagentType === type);
}

/**
 * Resolve agent name or subagent_type to an agent config.
 * Returns { agent: AgentConfig, resolvedName: string } or { error: string }.
 */
function resolveAgent(
  agents: AgentConfig[],
  agentName: string | undefined,
  subagentType: string | undefined,
): { agent?: AgentConfig; resolvedName?: string; error?: string } {
  // Check mutual exclusivity
  if (agentName && subagentType) {
    return {
      error: "Cannot specify both 'agent' and 'subagent_type'. Use one or the other.",
    };
  }

  // Must specify one
  if (!agentName && !subagentType) {
    return {
      error: "Must specify either 'agent' (agent name) or 'subagent_type' (agent type).",
    };
  }

  if (agentName) {
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) {
      const { text: available } = formatAgentList(agents, 10);
      return {
        error: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      };
    }
    return { agent, resolvedName: agentName };
  }

  if (subagentType) {
    const agent = findAgentByType(agents, subagentType);
    if (!agent) {
      const { text: available } = formatAgentList(agents, 10);
      const types = agents.map((a) => a.subagentType).filter(Boolean);
      const uniqueTypes = [...new Set(types)];
      const typeList = uniqueTypes.length > 0 ? uniqueTypes.join(", ") : "none defined";
      return {
        error: `No agent found with subagent_type: "${subagentType}". Available types: ${typeList}. Available agents: ${available}.`,
      };
    }
    return { agent, resolvedName: agent.name };
  }

  return { error: "Must specify either 'agent' or 'subagent_type'." };
}

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const WATCHDOG_CLEANUP_GRACE_MS = 5_000;
const WATCHDOG_CLOSE_WAIT_MS = 1_000;
const MAX_WATCHDOG_SECONDS = 2_147_483;
const DEFAULT_WATCHDOG = { idleSeconds: 300, toolSeconds: 600, taskSeconds: 1800 } as const;
type WatchdogConfig = {
  idleSeconds: number | null;
  toolSeconds: number | null;
  taskSeconds: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getMessageLifecycleKey(value: unknown, allowPending = false): string | undefined {
  if (!isRecord(value)) return undefined;
  const message = value;
  const { role, timestamp, content } = message;
  const supportedRoles = [
    "assistant",
    "toolResult",
    "user",
    "system",
    "custom",
    "bashExecution",
    "branchSummary",
    "compactionSummary",
  ];
  if (
    typeof role !== "string" ||
    !supportedRoles.includes(role) ||
    typeof timestamp !== "number" ||
    !Number.isFinite(timestamp)
  ) {
    return undefined;
  }
  if (role === "bashExecution") {
    if (
      typeof message.command !== "string" ||
      typeof message.output !== "string" ||
      (message.exitCode !== undefined && typeof message.exitCode !== "number") ||
      typeof message.cancelled !== "boolean" ||
      typeof message.truncated !== "boolean"
    ) {
      return undefined;
    }
  } else if (role === "branchSummary") {
    if (
      typeof message.summary !== "string" ||
      !(message.fromId === null || typeof message.fromId === "string")
    ) {
      return undefined;
    }
  } else if (role === "compactionSummary") {
    if (typeof message.summary !== "string" || typeof message.tokensBefore !== "number") {
      return undefined;
    }
  } else {
    if (
      !(
        typeof content === "string" ||
        (Array.isArray(content) &&
          content.every((part) => isRecord(part) && typeof part.type === "string"))
      ) ||
      ((role === "assistant" || role === "toolResult") && !Array.isArray(content))
    ) {
      return undefined;
    }
  }
  if (role === "assistant") {
    if (
      typeof message.api !== "string" ||
      typeof message.provider !== "string" ||
      typeof message.model !== "string" ||
      typeof message.stopReason !== "string" ||
      ![
        "stop",
        "length",
        "toolUse",
        "error",
        "aborted",
        "deferred",
        ...(allowPending ? ["pending"] : []),
      ].includes(message.stopReason)
    ) {
      return undefined;
    }
    const usage = message.usage;
    if (usage !== undefined) {
      if (
        !isRecord(usage) ||
        !["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
          (field) => typeof usage[field] === "number" && Number.isFinite(usage[field]),
        ) ||
        !isRecord(usage.cost) ||
        typeof usage.cost.total !== "number" ||
        !Number.isFinite(usage.cost.total)
      ) {
        return undefined;
      }
    }
  }
  if (
    role === "toolResult" &&
    (typeof message.toolCallId !== "string" ||
      typeof message.toolName !== "string" ||
      typeof message.isError !== "boolean")
  ) {
    return undefined;
  }
  return `${role}:${timestamp}`;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
  },
  model?: string,
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

function formatResultUsageStats(
  result: Pick<SingleResult, "usage" | "descendantUsage">,
  model?: string,
): string {
  const direct = formatUsageStats(result.usage, model);
  const descendant = result.descendantUsage ? formatUsageStats(result.descendantUsage) : "";
  return [direct, descendant ? `nested:${descendant}` : ""].filter(Boolean).join(" ");
}

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: any, text: string) => string,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "find ") +
        themeFg("accent", pattern) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "grep ") +
        themeFg("accent", `/${pattern}/`) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

type SubagentDetails = Omit<PersistedSubagentDetails, "results"> & {
  results: SingleResult[];
};

type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall")
          items.push({
            type: "toolCall",
            name: part.name,
            args: part.arguments,
          });
      }
    }
  }
  return items;
}

function getResultDisplayItems(
  result: Pick<SingleResult, "messages" | "displayItems">,
): DisplayItem[] {
  return result.messages.length > 0
    ? getDisplayItems(result.messages)
    : (result.displayItems ?? []);
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = Array.from({ length: items.length });
  let nextIndex = 0;
  const workers = Array.from({ length: limit })
    .fill(null)
    .map(async () => {
      while (true) {
        const current = nextIndex++;
        if (current >= items.length) return;
        results[current] = await fn(items[current], current);
      }
    });
  await Promise.all(workers);
  return results;
}

async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  try {
    await withFileMutationQueue(filePath, async () => {
      await fs.promises.writeFile(filePath, prompt, {
        encoding: "utf-8",
        mode: 0o600,
      });
    });
    return { dir: tmpDir, filePath };
  } catch (error) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const packageDir = getPackageDir();
  const cliScript = path.join(packageDir, "dist", "cli.js");
  const bundledCliScript = path.join(packageDir, "dist", "bundle", "cli.js");
  const sourceCliScript = path.join(packageDir, "src", "cli.ts");
  const currentScript = process.argv[1];
  if (currentScript && fs.existsSync(currentScript)) {
    const resolvedScript = fs.realpathSync(currentScript);
    const isPiCli = [cliScript, bundledCliScript, sourceCliScript].some(
      (candidate) => fs.existsSync(candidate) && fs.realpathSync(candidate) === resolvedScript,
    );
    if (isPiCli) return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  if (fs.existsSync(cliScript)) {
    return { command: process.execPath, args: [cliScript, ...args] };
  }

  return { command: "pi", args };
}

export function buildSubagentArgs(options: {
  model?: string;
  thinking?: SubagentThinkingLevel;
  tools?: string[];
  promptPath?: string;
  task: string;
}): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));
  if (options.promptPath) args.push("--append-system-prompt", options.promptPath);
  args.push(`Task: ${options.task}`);
  return args;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function formatWatchdogSummary(termination: WatchdogTermination): string {
  const activeTool = termination.activeTool
    ? `; active tool: ${termination.activeTool} (${termination.toolElapsedSeconds ?? 0}s)`
    : "";
  return (
    `Watchdog ${termination.deadline} deadline (${termination.limitSeconds}s) expired; ` +
    `elapsed: ${termination.elapsedSeconds}s; ` +
    `progress age: ${termination.lastProgressAgeSeconds}s${activeTool}; ` +
    `cleanup: ${termination.cleanup}.`
  );
}

function sanitizeWatchdogToolName(name: string): string {
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(name) ? name : "redacted";
}

function createModelErrorMatcher() {
  const terms = [
    "api key",
    "model",
    "not found",
    "unavailable",
    "not available",
    "provider",
    "error",
  ] as const;
  const found = new Set<string>();
  let tail = "";
  return {
    consume(text: string) {
      const input = tail + text.toLowerCase();
      for (const term of terms) if (input.includes(term)) found.add(term);
      tail = input.slice(-12);
    },
    matches() {
      return (
        found.has("api key") ||
        (found.has("model") &&
          (found.has("not found") || found.has("unavailable") || found.has("not available"))) ||
        (found.has("provider") && found.has("error"))
      );
    },
  };
}

function markResultAborted(result: SingleResult): void {
  if (result.exitCode <= 0) result.exitCode = 1;
  result.stopReason = "aborted";
  result.errorMessage = "Agent was aborted";
}

function resolveResultThinking(thinking: SubagentThinkingLevel | undefined): ResultThinking {
  if (thinking === undefined) return { thinkingKind: "default" };
  return { thinkingKind: "configured", thinking };
}

type RunSingleAgentOptions = {
  defaultCwd: string;
  agents: AgentConfig[];
  agentName: string | undefined;
  subagentType: string | undefined;
  task: string;
  cwd: string | undefined;
  step: number | undefined;
  signal: AbortSignal | undefined;
  onUpdate: OnUpdateCallback | undefined;
  makeDetails: (results: SingleResult[]) => SubagentDetails;
  overrides: AgentOverridesSnapshot;
  modelOverride?: string; // Model from tool input, takes priority
  mainAgentModel?: string; // Fallback: main agent's current model
  mainAgentThinking?: SubagentThinkingLevel; // Fallback: main agent's current thinking level
  thinkingOverride?: SubagentThinkingLevel | "inherit";
  inspector?: AgentInspectorStore;
  watchdog: WatchdogConfig;
};

async function runSingleAgent({
  defaultCwd,
  agents,
  agentName,
  subagentType,
  task,
  cwd,
  step,
  signal,
  onUpdate,
  makeDetails,
  overrides,
  modelOverride,
  mainAgentModel,
  mainAgentThinking,
  thinkingOverride,
  inspector,
  watchdog,
}: RunSingleAgentOptions): Promise<SingleResult> {
  const resolution = resolveAgent(agents, agentName, subagentType);

  if (resolution.error) {
    return {
      agent: agentName || subagentType || "unknown",
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: resolution.error,
      thinkingKind: "not-run",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      step,
    };
  }

  const agent = resolution.agent!;
  const resolvedName = resolution.resolvedName!;
  const overrideEntry = getAgentOverride(overrides, resolvedName);
  const configError = getAgentConfigurationError(agent, overrideEntry);
  if (configError !== undefined) {
    return {
      agent: resolvedName,
      agentSource: agent.source,
      task,
      exitCode: 1,
      messages: [],
      stderr: configError,
      thinkingKind: "not-run",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      step,
    };
  }

  const resolvedOptions = resolveAgentOptions(
    agent,
    overrideEntry?.kind === "valid" ? overrideEntry.value : undefined,
    {
      modelOverride,
      parentModel: mainAgentModel,
      parentThinking: mainAgentThinking,
      thinkingOverride,
    },
  );
  const { modelsToTry } = resolvedOptions;
  const taskStartedAt = performance.now();
  const runAbortController = new AbortController();
  const forwardAbort = () => runAbortController.abort();
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  const inspectorRun = inspector?.start({
    agent: resolvedName,
    task,
    model: modelsToTry[0],
    thinking: resolvedOptions.thinking,
  });
  inspectorRun?.setStopper(() => runAbortController.abort());

  // Helper function to run with a specific model
  let modelErrorMatcher = createModelErrorMatcher();
  const runWithModel = async (model: string | undefined): Promise<SingleResult> => {
    modelErrorMatcher = createModelErrorMatcher();
    let tmpPromptDir: string | null = null;
    let tmpPromptPath: string | null = null;

    const currentResult: SingleResult = {
      agent: resolvedName,
      agentSource: agent.source,
      task,
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
      model: model,
      ...resolveResultThinking(resolvedOptions.thinking),
      systemPromptOverridden: resolvedOptions.systemPromptOverridden,
      step,
    };

    const emitUpdate = () => {
      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: `${resolvedName} running...` }],
          details: makeDetails([{ ...currentResult, messages: [] }]),
        });
      }
    };

    const captureNestedUsage = (message: Message): void => {
      if (message.role !== "toolResult") return;

      const toolUsage = parsePiUsage(message.usage);
      if (toolUsage) {
        currentResult.descendantUsage ??= createUsageTotals();
        addUsageTotals(currentResult.descendantUsage, toolUsage);
      }

      if (message.toolName !== "agent") return;
      const nestedUsage = getPersistedSubagentUsage(message.details);
      if (nestedUsage.recognized) {
        currentResult.descendantUsage ??= createUsageTotals();
        addUsageTotals(currentResult.descendantUsage, nestedUsage.totals);
        if (nestedUsage.runs > 0) {
          currentResult.descendantRuns = (currentResult.descendantRuns ?? 0) + nestedUsage.runs;
        }
      }
    };

    try {
      if (resolvedOptions.systemPrompt.trim()) {
        const tmp = await writePromptToTempFile(agent.name, resolvedOptions.systemPrompt);
        tmpPromptDir = tmp.dir;
        tmpPromptPath = tmp.filePath;
      }

      const args = buildSubagentArgs({
        model,
        thinking: resolvedOptions.thinking,
        tools: resolvedOptions.tools,
        promptPath: tmpPromptPath ?? undefined,
        task,
      });
      inspectorRun?.setModel(model);
      let wasAborted = false;

      if (runAbortController.signal.aborted) {
        markResultAborted(currentResult);
        return currentResult;
      }

      let watchdogTermination: WatchdogTermination | undefined;
      const exitCode = await new Promise<number>((resolve) => {
        const invocation = getPiInvocation(args);
        const proc = spawn(invocation.command, invocation.args, {
          cwd: cwd ?? defaultCwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
        let buffer = "";
        let discardingLine = false;
        let stdoutTruncated = false;
        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        let stderrTruncated = false;
        let closed = false;
        let directChildExited = false;
        let cleanupAbort = () => {};
        const runStartedAt = performance.now();
        let lastProgressAt = runStartedAt;
        const activeTools = new Map<string, { name: string; startedAt: number; update: string }>();
        const startedMessages = new Map<string, number>();
        let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
        let escalationTimer: ReturnType<typeof setTimeout> | undefined;
        let boundedCloseTimer: ReturnType<typeof setTimeout> | undefined;
        let finishRun: ((exitCode: number) => void) | undefined;
        const now = () => performance.now();
        const sendCleanupSignal = (signalName: NodeJS.Signals) => {
          if (closed || directChildExited) return;
          if (process.platform !== "win32" && typeof proc.pid === "number" && proc.pid > 0) {
            try {
              process.kill(-proc.pid, signalName);
              return;
            } catch {
              // Fall back to the ChildProcess handle, which identifies this child.
            }
          }
          try {
            proc.kill(signalName);
          } catch {
            // Cleanup remains unknown when the operating system rejects a signal.
          }
        };
        const recordProgress = () => {
          if (watchdogTermination) return;
          lastProgressAt = now();
          scheduleWatchdog();
        };
        const scheduleWatchdog = () => {
          if (watchdogTermination) return;
          if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
          const currentTime = now();
          const deadlines: Array<{
            deadline: WatchdogTermination["deadline"];
            dueAt: number;
            limitSeconds: number;
            toolId?: string;
          }> = [];
          if (watchdog.idleSeconds !== null)
            deadlines.push({
              deadline: "idle",
              dueAt: lastProgressAt + watchdog.idleSeconds * 1000,
              limitSeconds: watchdog.idleSeconds,
            });
          if (watchdog.taskSeconds !== null)
            deadlines.push({
              deadline: "task",
              dueAt: taskStartedAt + watchdog.taskSeconds * 1000,
              limitSeconds: watchdog.taskSeconds,
            });
          if (watchdog.toolSeconds !== null) {
            for (const [toolId, tool] of activeTools)
              deadlines.push({
                deadline: "tool",
                dueAt: tool.startedAt + watchdog.toolSeconds * 1000,
                limitSeconds: watchdog.toolSeconds,
                toolId,
              });
          }
          if (deadlines.length === 0) return;
          const priority = { task: 0, tool: 1, idle: 2 };
          deadlines.sort(
            (a, b) => a.dueAt - b.dueAt || priority[a.deadline] - priority[b.deadline],
          );
          const next = deadlines[0];
          watchdogTimer = setTimeout(
            () => {
              const expiredAt = now();
              const expired = deadlines.find((deadline) => deadline.dueAt <= expiredAt);
              if (closed || runAbortController.signal.aborted) return;
              if (!expired) return scheduleWatchdog();
              const active = expired.toolId
                ? activeTools.get(expired.toolId)
                : activeTools.values().next().value;
              watchdogTermination = {
                kind: "watchdog",
                deadline: expired.deadline,
                limitSeconds: expired.limitSeconds,
                elapsedSeconds: Math.max(0, Math.round((expiredAt - runStartedAt) / 1000)),
                ...(active
                  ? {
                      activeTool: sanitizeWatchdogToolName(active.name),
                      toolElapsedSeconds: Math.max(
                        0,
                        Math.round((expiredAt - active.startedAt) / 1000),
                      ),
                    }
                  : {}),
                lastProgressAgeSeconds: Math.max(
                  0,
                  Math.round((expiredAt - lastProgressAt) / 1000),
                ),
                cleanup: "unknown",
              };
              sendCleanupSignal("SIGTERM");
              escalationTimer = setTimeout(() => {
                if (!closed && !directChildExited) sendCleanupSignal("SIGKILL");
                boundedCloseTimer = setTimeout(() => finishRun?.(1), WATCHDOG_CLOSE_WAIT_MS);
              }, WATCHDOG_CLEANUP_GRACE_MS);
            },
            Math.max(0, next.dueAt - currentTime),
          );
        };
        scheduleWatchdog();

        const processLine = (line: string) => {
          if (!line.trim()) return;
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }

          if (!event || typeof event !== "object" || Array.isArray(event)) return;

          if (event.type === "message_start") {
            const messageKey = getMessageLifecycleKey(event.message, true);
            if (messageKey) {
              startedMessages.set(messageKey, (startedMessages.get(messageKey) ?? 0) + 1);
            }
            if (event.message?.role === "assistant" && messageKey) {
              inspectorRun?.messageStart(getInspectorMessageText(event.message));
            }
          }

          if (event.type === "message_update" && event.assistantMessageEvent) {
            const assistantEvent = event.assistantMessageEvent;
            if (
              (assistantEvent.type === "text_delta" || assistantEvent.type === "thinking_delta") &&
              typeof assistantEvent.delta === "string" &&
              assistantEvent.delta.length > 0
            ) {
              recordProgress();
            }
            if (assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string") {
              inspectorRun?.appendText(assistantEvent.delta);
            }
          }

          if (
            event.type === "tool_execution_start" &&
            typeof event.toolCallId === "string" &&
            event.toolCallId.length > 0 &&
            typeof event.toolName === "string" &&
            event.toolName.length > 0 &&
            !activeTools.has(event.toolCallId)
          ) {
            activeTools.set(event.toolCallId, {
              name: event.toolName,
              startedAt: now(),
              update: "",
            });
            recordProgress();
            inspectorRun?.toolStart(event.toolCallId, event.toolName, event.args ?? {});
          }

          if (event.type === "tool_execution_update" && event.toolCallId) {
            const tool = activeTools.get(event.toolCallId);
            const update = getInspectorText(event.partialResult);
            const boundedUpdate = update.slice(-8_000);
            if (tool && boundedUpdate && boundedUpdate !== tool.update) {
              tool.update = boundedUpdate;
              recordProgress();
            }
            inspectorRun?.toolUpdate(event.toolCallId, update);
          }

          if (event.type === "tool_execution_end" && event.toolCallId) {
            const matchedTool = activeTools.delete(event.toolCallId);
            if (matchedTool) recordProgress();
            inspectorRun?.toolEnd(
              event.toolCallId,
              getInspectorText(event.result),
              Boolean(event.isError),
            );
          }

          if (event.type === "message_end") {
            const messageKey = getMessageLifecycleKey(event.message);
            const startedCount = messageKey ? (startedMessages.get(messageKey) ?? 0) : 0;
            if (!messageKey || startedCount === 0) return;
            if (startedCount === 1) startedMessages.delete(messageKey);
            else startedMessages.set(messageKey, startedCount - 1);

            const msg = event.message as Message;
            recordProgress();
            captureNestedUsage(msg);
            currentResult.messages.push(msg);

            if (msg.role === "assistant") {
              inspectorRun?.messageEnd(getInspectorMessageText(msg));
              currentResult.usage.turns++;
              const usage = msg.usage;
              if (usage) {
                currentResult.usage.input += usage.input || 0;
                currentResult.usage.output += usage.output || 0;
                currentResult.usage.cacheRead += usage.cacheRead || 0;
                currentResult.usage.cacheWrite += usage.cacheWrite || 0;
                currentResult.usage.cost += usage.cost?.total || 0;
                currentResult.usage.contextTokens = usage.totalTokens || 0;
              }
              if (!currentResult.model && msg.model) {
                currentResult.model = msg.model;
                inspectorRun?.setModel(msg.model);
              }
              if (msg.stopReason) currentResult.stopReason = msg.stopReason;
              if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
            }
            emitUpdate();
          }
        };

        const consumeStdout = (text: string) => {
          let offset = 0;
          while (offset < text.length) {
            const newline = text.indexOf("\n", offset);
            const end = newline === -1 ? text.length : newline;
            if (!discardingLine) {
              if (buffer.length + end - offset > 1024 * 1024) {
                buffer = "";
                discardingLine = true;
                stdoutTruncated = true;
              } else {
                buffer += text.slice(offset, end);
              }
            }
            if (newline === -1) break;
            if (!discardingLine) processLine(buffer);
            buffer = "";
            discardingLine = false;
            offset = newline + 1;
          }
        };
        proc.stdout.on("data", (data) => {
          if (closed) return;
          consumeStdout(typeof data === "string" ? data : stdoutDecoder.write(data));
        });

        const consumeStderr = (text: string) => {
          modelErrorMatcher.consume(text);
          if (stderrTruncated) return;
          const remaining = 64 * 1024 - currentResult.stderr.length;
          if (text.length <= remaining) {
            currentResult.stderr += text;
            return;
          }
          let prefix = text.slice(0, remaining);
          if (prefix.length > 0 && /[\uD800-\uDBFF]/.test(prefix[prefix.length - 1])) {
            prefix = prefix.slice(0, -1);
          }
          currentResult.stderr += prefix;
          stderrTruncated = true;
        };
        proc.stderr.on("data", (data) => {
          if (!closed) {
            consumeStderr(typeof data === "string" ? data : stderrDecoder.write(data));
          }
        });

        const finish = (exitCode: number) => {
          if (closed) return;
          closed = true;
          if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
          if (escalationTimer !== undefined) clearTimeout(escalationTimer);
          if (boundedCloseTimer !== undefined) clearTimeout(boundedCloseTimer);
          cleanupAbort();
          consumeStderr(stderrDecoder.end());
          if (stderrTruncated) currentResult.stderr += "\n[stderr truncated]";
          if (stdoutTruncated) currentResult.stderr += "\n[stdout line truncated]";
          resolve(exitCode);
        };
        finishRun = finish;

        proc.on("exit", () => {
          directChildExited = true;
        });

        proc.on("close", (code, signalName) => {
          if (closed) return;
          consumeStdout(stdoutDecoder.end());
          if (!discardingLine && buffer.trim()) processLine(buffer);
          finish(signalName ? 1 : (code ?? 1));
        });

        proc.on("error", () => {
          directChildExited = true;
          finish(1);
        });

        cleanupAbort = installAbortHandler({
          signal: runAbortController.signal,
          process: {
            kill: (signalName) => {
              if (!watchdogTermination) sendCleanupSignal(signalName);
              return true;
            },
          },
          isClosed: () => closed || !!watchdogTermination,
          onAbort: () => {
            if (watchdogTermination) return;
            wasAborted = true;
            if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
            boundedCloseTimer = setTimeout(
              () => finishRun?.(1),
              WATCHDOG_CLEANUP_GRACE_MS + WATCHDOG_CLOSE_WAIT_MS,
            );
          },
        });
      });

      currentResult.exitCode = exitCode;
      if (watchdogTermination) {
        currentResult.termination = watchdogTermination;
        currentResult.exitCode = 1;
        currentResult.errorMessage = formatWatchdogSummary(watchdogTermination);
        currentResult.stderr = "";
      } else if (wasAborted) {
        currentResult.termination = { kind: "abort", cleanup: "unknown" };
        markResultAborted(currentResult);
      }
      return currentResult;
    } finally {
      if (tmpPromptPath)
        try {
          fs.unlinkSync(tmpPromptPath);
        } catch {
          /* ignore */
        }
      if (tmpPromptDir)
        try {
          fs.rmdirSync(tmpPromptDir);
        } catch {
          /* ignore */
        }
    }
  };

  // Try models in order, falling back on model/API key errors
  const previousUsage = createUsageTotalsWithTurns();
  const previousDescendantUsage = createUsageTotals();
  let previousDescendantRuns = 0;
  const mergePreviousUsage = (result: SingleResult): SingleResult => {
    addUsageTotalsWithTurns(result.usage, previousUsage);
    if (hasUsageTotals(previousDescendantUsage)) {
      result.descendantUsage ??= createUsageTotals();
      addUsageTotals(result.descendantUsage, previousDescendantUsage);
    }
    if (previousDescendantRuns > 0) {
      result.descendantRuns = (result.descendantRuns ?? 0) + previousDescendantRuns;
    }
    return result;
  };
  let lastResult: SingleResult | undefined;
  try {
    for (let i = 0; i < modelsToTry.length; i++) {
      const model = modelsToTry[i];
      const result = await runWithModel(model);
      lastResult = result;

      if (result.termination?.kind === "watchdog") return mergePreviousUsage(result);

      if (runAbortController.signal.aborted) {
        markResultAborted(result);
        return mergePreviousUsage(result);
      }

      // Success - return immediately
      if (isCompletedResult(result)) {
        return mergePreviousUsage(result);
      }

      // Check if this is a model/API key error that warrants a fallback
      const shouldFallback = modelErrorMatcher.matches() && i < modelsToTry.length - 1;
      if (!shouldFallback) {
        // No more fallbacks or error is not model-related
        return mergePreviousUsage(result);
      }

      addUsageTotalsWithTurns(previousUsage, result.usage);
      if (result.descendantUsage) addUsageTotals(previousDescendantUsage, result.descendantUsage);
      previousDescendantRuns += result.descendantRuns ?? 0;

      // Log fallback for debugging
      const nextModel = modelsToTry[i + 1];
      result.stderr += `\n[Fallback] Model "${model ?? "default"}" failed, trying "${nextModel ?? "default"}"...`;
    }

    // Should not reach here, but return last result just in case
    return lastResult ? mergePreviousUsage(lastResult) : lastResult!;
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
    if (inspectorRun?.status() === "running") {
      const status =
        lastResult?.termination?.kind === "watchdog"
          ? "timed out"
          : lastResult?.stopReason === "aborted"
            ? "aborted"
            : lastResult && isCompletedResult(lastResult)
              ? "completed"
              : "failed";
      inspectorRun.finish(
        status,
        lastResult?.termination?.kind === "abort" ? "unknown" : undefined,
      );
    }
  }
}

const ThinkingInput = StringEnum(
  ["off", "minimal", "low", "medium", "high", "xhigh", "max", "inherit"] as const,
  {
    description:
      "Thinking level. 'inherit' uses the parent level. Overrides settings and frontmatter.",
  },
);

const ModelInput = Type.String({
  description:
    "Model as provider/id, or 'inherit' for the parent model. Overrides settings and frontmatter.",
});

const WatchdogLimit = Type.Union([
  Type.Integer({ minimum: 1, maximum: MAX_WATCHDOG_SECONDS }),
  Type.Null(),
]);
const WatchdogInput = Type.Object({
  idleSeconds: Type.Optional(WatchdogLimit),
  toolSeconds: Type.Optional(WatchdogLimit),
  taskSeconds: Type.Optional(WatchdogLimit),
});

function resolveWatchdog(override?: Partial<WatchdogConfig>): WatchdogConfig {
  return {
    idleSeconds:
      override && "idleSeconds" in override
        ? (override.idleSeconds ?? null)
        : DEFAULT_WATCHDOG.idleSeconds,
    toolSeconds:
      override && "toolSeconds" in override
        ? (override.toolSeconds ?? null)
        : DEFAULT_WATCHDOG.toolSeconds,
    taskSeconds:
      override && "taskSeconds" in override
        ? (override.taskSeconds ?? null)
        : DEFAULT_WATCHDOG.taskSeconds,
  };
}

const TaskItem = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke" })),
  subagent_type: Type.Optional(
    Type.String({
      description:
        "Type of subagent to invoke (e.g., 'planning', 'review'). Mutually exclusive with 'agent'.",
    }),
  ),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
  model: Type.Optional(ModelInput),
  thinking: Type.Optional(ThinkingInput),
  watchdog: Type.Optional(WatchdogInput),
});

const ChainItem = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke" })),
  subagent_type: Type.Optional(
    Type.String({
      description:
        "Type of subagent to invoke (e.g., 'planning', 'review'). Mutually exclusive with 'agent'.",
    }),
  ),
  task: Type.String({
    description: "Task with optional {previous} placeholder for prior output",
  }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
  model: Type.Optional(ModelInput),
  thinking: Type.Optional(ThinkingInput),
  watchdog: Type.Optional(WatchdogInput),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description:
    'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
  default: "user",
});

const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({
      description: "Name of the agent to invoke (for single mode)",
    }),
  ),
  subagent_type: Type.Optional(
    Type.String({
      description:
        "Type of subagent to invoke (e.g., 'planning', 'review'). Mutually exclusive with 'agent'.",
    }),
  ),
  task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
  model: Type.Optional(ModelInput),
  thinking: Type.Optional(ThinkingInput),
  watchdog: Type.Optional(
    Type.Object(
      {
        idleSeconds: Type.Optional(WatchdogLimit),
        toolSeconds: Type.Optional(WatchdogLimit),
        taskSeconds: Type.Optional(WatchdogLimit),
      },
      {
        description:
          "Watchdog deadlines in seconds. Defaults: idle 300, tool 600, task 1800. Set a field to null to disable it.",
      },
    ),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, {
      description: "Array of {agent, task} for parallel execution",
    }),
  ),
  chain: Type.Optional(
    Type.Array(ChainItem, {
      description: "Array of {agent, task} for sequential execution",
    }),
  ),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description: "Prompt before running project-local agents. Default: true.",
      default: true,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the agent process (single mode)",
    }),
  ),
});

export default function (pi: ExtensionAPI) {
  const inspector = new AgentInspectorStore();
  let activeInspectorClose: (() => void) | undefined;
  const openInspector = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("The subagent inspector requires interactive TUI mode.", "error");
      return;
    }
    if (activeInspectorClose) return;

    let component: AgentInspectorComponent | undefined;
    let finishCustom: (() => void) | undefined;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      component?.dispose();
      finishCustom?.();
      activeInspectorClose = undefined;
    };
    activeInspectorClose = close;

    try {
      await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
        finishCustom = done;
        component = new AgentInspectorComponent(tui, theme, keybindings, inspector, close);
        return component;
      });
    } finally {
      close();
    }
  };

  pi.on("session_shutdown", () => {
    activeInspectorClose?.();
    inspector.clear();
  });

  pi.registerCommand("agent-inspector", {
    description: "Inspect running and recently completed subagents",
    handler: async (_args, ctx) => openInspector(ctx),
  });

  pi.registerShortcut("ctrl+shift+a", {
    description: "Inspect running and recently completed subagents",
    handler: async (ctx) => openInspector(ctx),
  });

  pi.registerTool({
    name: "agent",
    label: "Agent",
    description: [
      "Delegate tasks to specialized agents with isolated context.",
      "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
      "Omit model and thinking by default; set either only when the user explicitly requests an override.",
      "'inherit' is an explicit override, not the default.",
      "Model priority: input model > settings override > agent frontmatter > main agent model.",
      "Thinking priority: input thinking > settings override > agent frontmatter > main agent thinking.",
      "Use model: 'inherit' and thinking: 'inherit' to select the parent values even when an agent has overrides.",
      "Watchdog defaults are 300 seconds idle, 600 seconds per tool, and 1800 seconds per run; override individual limits in seconds or set null to disable. Limits apply to single runs and as defaults for parallel or chain items. A timed-out child may have made partial changes; inspect its artifact and worktree. Parallel calls wait for other tasks to finish or time out.",
      "Each task returns a Markdown artifact path. Read the relevant file before continuing.",
      'Default agent scope is "user" (from ~/.pi/agent/agents).',
      'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
    ].join(" "),
    parameters: SubagentParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = params.agentScope ?? "user";
      // Get the main agent's current model as fallback (format: "provider/id")
      const mainAgentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const mainAgentThinking = pi.getThinkingLevel?.();
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const confirmProjectAgents = params.confirmProjectAgents ?? true;

      const topWatchdog = resolveWatchdog(params.watchdog);
      const watchdogItems = [...(params.tasks ?? []), ...(params.chain ?? [])];
      const watchdogValues = [params.watchdog, ...watchdogItems.map((item) => item.watchdog)];
      const invalidWatchdog = watchdogValues.some(
        (value) =>
          value &&
          Object.values(value).some(
            (seconds) =>
              seconds !== null &&
              (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_WATCHDOG_SECONDS),
          ),
      );
      if (invalidWatchdog) {
        return {
          content: [
            {
              type: "text",
              text: `Watchdog limits must be positive integer seconds up to ${MAX_WATCHDOG_SECONDS}, or null.`,
            },
          ],
          details: {
            usageVersion: 3,
            mode: "single",
            agentScope,
            projectAgentsDir: discovery.projectAgentsDir,
            results: [],
          },
          isError: true,
        };
      }
      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean((params.agent || params.subagent_type) && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const makeDetails =
        (mode: "single" | "parallel" | "chain") =>
        (results: SingleResult[]): SubagentDetails => ({
          usageVersion: 3,
          mode,
          agentScope,
          projectAgentsDir: discovery.projectAgentsDir,
          results,
        });
      const requestedMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
      const sessionFile =
        ctx.sessionManager.getSessionFile() ??
        path.join(
          await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-session-")),
          "session.jsonl",
        );
      const artifactPath = (mode: "single" | "parallel" | "chain", agent: string, index?: number) =>
        buildArtifactPath({ sessionFile, toolCallId, mode, index, agent });
      const persistResultArtifact = async (options: {
        result: SingleResult;
        mode: "single" | "parallel" | "chain";
        index?: number;
        taskLabel: string;
        startedAt: string;
      }) =>
        writeResultArtifact({
          result: options.result,
          outputPath: artifactPath(options.mode, options.result.agent, options.index),
          taskLabel: options.taskLabel,
          startedAt: options.startedAt,
        });

      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
            },
          ],
          details: makeDetails("single")([]),
        };
      }

      let overrides: AgentOverridesSnapshot;
      try {
        overrides = loadAgentOverrides();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to load subagent overrides.";
        const requestedTasks =
          hasTasks && params.tasks
            ? params.tasks
            : hasChain && params.chain
              ? params.chain.slice(0, 1)
              : [
                  {
                    agent: params.agent,
                    subagent_type: params.subagent_type,
                    task: params.task ?? "",
                  },
                ];
        const results: SingleResult[] = [];
        for (const [index, requested] of requestedTasks.entries()) {
          const result: SingleResult = {
            agent: requested.agent || requested.subagent_type || "unknown",
            agentSource: "unknown",
            task: requested.task,
            exitCode: 1,
            messages: [],
            stderr: message,
            thinkingKind: "not-run",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
            ...(hasChain ? { step: index + 1 } : {}),
          };
          await persistResultArtifact({
            result,
            mode: requestedMode,
            index: requestedMode === "single" ? undefined : index + 1,
            taskLabel:
              requestedMode === "single"
                ? "single task"
                : `${requestedMode === "chain" ? "chain step" : "parallel item"} ${index + 1}`,
            startedAt: new Date().toISOString(),
          });
          results.push(result);
        }
        const summary =
          requestedMode === "single"
            ? formatSingleSummary(results[0], results[0].outputPath!)
            : requestedMode === "chain"
              ? `Chain stopped at step 1 (${results[0].agent}).\n${formatChainSummary(results)}`
              : formatParallelSummary(
                  results.map((result) => ({
                    agent: result.agent,
                    exitCode: result.exitCode,
                    stopReason: result.stopReason,
                    outputPath: result.outputPath!,
                  })),
                );
        return {
          content: [{ type: "text", text: summary }],
          details: makeDetails(requestedMode)(results),
          isError: true,
        };
      }

      if (
        (agentScope === "project" || agentScope === "both") &&
        confirmProjectAgents &&
        ctx.hasUI
      ) {
        const requestedAgentNames = new Set<string>();
        if (params.chain)
          for (const step of params.chain) {
            if (step.agent) requestedAgentNames.add(step.agent);
            if (step.subagent_type) {
              const agent = findAgentByType(agents, step.subagent_type);
              if (agent) requestedAgentNames.add(agent.name);
            }
          }
        if (params.tasks)
          for (const t of params.tasks) {
            if (t.agent) requestedAgentNames.add(t.agent);
            if (t.subagent_type) {
              const agent = findAgentByType(agents, t.subagent_type);
              if (agent) requestedAgentNames.add(agent.name);
            }
          }
        if (params.agent) requestedAgentNames.add(params.agent);
        if (params.subagent_type) {
          const agent = findAgentByType(agents, params.subagent_type);
          if (agent) requestedAgentNames.add(agent.name);
        }

        const projectAgentsRequested = Array.from(requestedAgentNames)
          .map((name) => agents.find((a) => a.name === name))
          .filter((a): a is AgentConfig => a?.source === "project");

        if (projectAgentsRequested.length > 0) {
          const names = projectAgentsRequested.map((a) => a.name).join(", ");
          const dir = discovery.projectAgentsDir ?? "(unknown)";
          const ok = await ctx.ui.confirm(
            "Run project-local agents?",
            `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
          );
          if (!ok)
            return {
              content: [
                {
                  type: "text",
                  text: "Canceled: project-local agents not approved.",
                },
              ],
              details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
            };
        }
      }

      if (params.chain && params.chain.length > 0) {
        // Validate chain items have agent or subagent_type
        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          if (!step.agent && !step.subagent_type) {
            return {
              content: [
                {
                  type: "text",
                  text: `Chain step ${i + 1}: Must specify either 'agent' or 'subagent_type'.`,
                },
              ],
              details: makeDetails("chain")([]),
            };
          }
          if (step.agent && step.subagent_type) {
            return {
              content: [
                {
                  type: "text",
                  text: `Chain step ${i + 1}: Cannot specify both 'agent' and 'subagent_type'.`,
                },
              ],
              details: makeDetails("chain")([]),
            };
          }
        }

        const results: SingleResult[] = [];
        let previousOutput = "";

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

          // Create update callback that includes all previous results
          const chainUpdate: OnUpdateCallback | undefined = onUpdate
            ? (partial) => {
                // Combine completed results with current streaming result
                const currentResult = partial.details?.results[0];
                if (currentResult) {
                  const allResults = [...results, currentResult];
                  onUpdate({
                    content: partial.content,
                    details: makeDetails("chain")(allResults),
                  });
                }
              }
            : undefined;

          const startedAt = new Date().toISOString();
          const result = await runSingleAgent({
            defaultCwd: ctx.cwd,
            agents,
            agentName: step.agent,
            subagentType: step.subagent_type,
            task: taskWithContext,
            cwd: step.cwd,
            step: i + 1,
            signal,
            onUpdate: chainUpdate,
            makeDetails: makeDetails("chain"),
            overrides,
            modelOverride: step.model ?? params.model, // step.model takes priority, then top-level params.model
            mainAgentModel,
            mainAgentThinking,
            thinkingOverride: step.thinking ?? params.thinking,
            inspector,
            watchdog: resolveWatchdog({ ...topWatchdog, ...step.watchdog }),
          });
          const previousResultOutput = getFinalOutput(result.messages);
          await persistResultArtifact({
            result,
            mode: "chain",
            index: i + 1,
            taskLabel: `chain step ${i + 1}`,
            startedAt,
          });
          results.push(result);

          const isError = getResultStatus(result) === "failed";
          if (isError) {
            const displayName = step.agent || step.subagent_type || "unknown";
            return {
              content: [
                {
                  type: "text",
                  text: `Chain stopped at step ${i + 1} (${displayName}).\n${formatChainSummary(results)}`,
                },
              ],
              details: makeDetails("chain")(results),
              isError: true,
            };
          }
          previousOutput = previousResultOutput;
        }
        return {
          content: [{ type: "text", text: formatChainSummary(results) }],
          details: makeDetails("chain")(results),
        };
      }

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS)
          return {
            content: [
              {
                type: "text",
                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
              },
            ],
            details: makeDetails("parallel")([]),
          };

        // Validate task items
        for (let i = 0; i < params.tasks.length; i++) {
          const t = params.tasks[i];
          if (!t.agent && !t.subagent_type) {
            return {
              content: [
                {
                  type: "text",
                  text: `Task ${i + 1}: Must specify either 'agent' or 'subagent_type'.`,
                },
              ],
              details: makeDetails("parallel")([]),
            };
          }
          if (t.agent && t.subagent_type) {
            return {
              content: [
                {
                  type: "text",
                  text: `Task ${i + 1}: Cannot specify both 'agent' and 'subagent_type'.`,
                },
              ],
              details: makeDetails("parallel")([]),
            };
          }
        }

        // Track all results for streaming updates
        const allResults: SingleResult[] = Array.from({ length: params.tasks.length });

        // Initialize placeholder results
        for (let i = 0; i < params.tasks.length; i++) {
          const t = params.tasks[i];
          const displayName = t.agent || t.subagent_type || "unknown";
          allResults[i] = {
            agent: displayName,
            agentSource: "unknown",
            task: t.task,
            exitCode: -1, // -1 = still running
            messages: [],
            stderr: "",
            thinkingKind: "not-run",
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
        }

        const emitParallelUpdate = () => {
          if (onUpdate) {
            const statuses = allResults.map((r) => getResultStatus(r));
            const running = statuses.filter((status) => status === "running").length;
            const done = statuses.length - running;
            onUpdate({
              content: [
                {
                  type: "text",
                  text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
                },
              ],
              details: makeDetails("parallel")([...allResults]),
            });
          }
        };

        const results = await mapWithConcurrencyLimit(
          params.tasks,
          MAX_CONCURRENCY,
          async (t, index) => {
            const startedAt = new Date().toISOString();
            const result = await runSingleAgent({
              defaultCwd: ctx.cwd,
              agents,
              agentName: t.agent,
              subagentType: t.subagent_type,
              task: t.task,
              cwd: t.cwd,
              step: undefined,
              signal,
              onUpdate: (partial) => {
                if (partial.details?.results[0]) {
                  allResults[index] = partial.details.results[0];
                  emitParallelUpdate();
                }
              },
              makeDetails: makeDetails("parallel"),
              overrides,
              modelOverride: t.model ?? params.model, // task.model takes priority, then top-level params.model
              mainAgentModel,
              mainAgentThinking,
              thinkingOverride: t.thinking ?? params.thinking,
              inspector,
              watchdog: resolveWatchdog({ ...topWatchdog, ...t.watchdog }),
            });
            await persistResultArtifact({
              result,
              mode: "parallel",
              index: index + 1,
              taskLabel: `parallel item ${index + 1}`,
              startedAt,
            });
            allResults[index] = result;
            emitParallelUpdate();
            return result;
          },
        );

        const text = formatParallelSummary(
          results.map((r) => ({
            agent: r.agent,
            exitCode: r.exitCode,
            stopReason: r.stopReason,
            termination: r.termination,
            outputPath: r.outputPath!,
          })),
        );
        return {
          content: [{ type: "text", text }],
          details: makeDetails("parallel")(results),
        };
      }

      if ((params.agent || params.subagent_type) && params.task) {
        const startedAt = new Date().toISOString();
        const result = await runSingleAgent({
          defaultCwd: ctx.cwd,
          agents,
          agentName: params.agent,
          subagentType: params.subagent_type,
          task: params.task,
          cwd: params.cwd,
          step: undefined,
          signal,
          onUpdate,
          makeDetails: makeDetails("single"),
          overrides,
          modelOverride: params.model, // top-level model for single mode
          mainAgentModel,
          mainAgentThinking,
          thinkingOverride: params.thinking,
          inspector,
          watchdog: topWatchdog,
        });
        await persistResultArtifact({
          result,
          mode: "single",
          taskLabel: "single task",
          startedAt,
        });
        const isError = getResultStatus(result) === "failed";
        if (isError) {
          return {
            content: [
              {
                type: "text",
                text: formatSingleSummary(result, result.outputPath!),
              },
            ],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: formatSingleSummary(result, result.outputPath!),
            },
          ],
          details: makeDetails("single")([result]),
        };
      }

      const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
      return {
        content: [
          {
            type: "text",
            text: `Invalid parameters. Available agents: ${available}`,
          },
        ],
        details: makeDetails("single")([]),
      };
    },

    renderCall(args, theme, _context) {
      const scope: AgentScope = args.agentScope ?? "user";
      if (args.chain && args.chain.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("agent ")) +
          theme.fg("accent", `chain (${args.chain.length} steps)`) +
          theme.fg("muted", ` [${scope}]`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const step = args.chain[i];
          // Clean up {previous} placeholder for display
          const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
          const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          text +=
            "\n  " +
            theme.fg("muted", `${i + 1}.`) +
            " " +
            theme.fg(
              "accent",
              step.agent || (step.subagent_type ? `<${step.subagent_type}>` : "..."),
            ) +
            theme.fg("dim", ` ${preview}`);
        }
        if (args.chain.length > 3)
          text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("agent ")) +
          theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
          theme.fg("muted", ` [${scope}]`);
        for (const t of args.tasks.slice(0, 3)) {
          const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
          text += `\n  ${theme.fg("accent", t.agent || (t.subagent_type ? `<${t.subagent_type}>` : "..."))}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.tasks.length > 3)
          text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      const agentName = args.agent || (args.subagent_type ? `<${args.subagent_type}>` : "...");
      const preview = args.task
        ? args.task.length > 60
          ? `${args.task.slice(0, 60)}...`
          : args.task
        : "...";
      let text =
        theme.fg("toolTitle", theme.bold("agent ")) +
        theme.fg("accent", agentName) +
        theme.fg("muted", ` [${scope}]`);
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, _context) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0 || isPartial) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const mdTheme = getMarkdownTheme();
      const statusIcon = (status: ReturnType<typeof getResultStatus>) =>
        status === "running"
          ? theme.fg("warning", "⏳")
          : status === "failed"
            ? theme.fg("error", "✗")
            : theme.fg("success", "✓");

      const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped = limit && items.length > limit ? items.length - limit : 0;
        let text = "";
        if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
        for (const item of toShow) {
          if (item.type === "text") {
            const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
            text += `${theme.fg("toolOutput", preview)}\n`;
          } else {
            text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
          }
        }
        return text.trimEnd();
      };

      if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0];
        const status = getResultStatus(r);
        const isError = status === "failed";
        const icon = statusIcon(status);
        const displayItems = getResultDisplayItems(r);
        const finalOutput = expanded ? getResultOutput(r) : "";

        if (expanded) {
          const container = new Container();
          let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
          if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
          container.addChild(new Text(header, 0, 0));
          if (isError && r.errorMessage)
            container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
          container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
          if (displayItems.length === 0 && !finalOutput) {
            container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
          } else {
            for (const item of displayItems) {
              if (item.type === "toolCall")
                container.addChild(
                  new Text(
                    theme.fg("muted", "→ ") +
                      formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                    0,
                    0,
                  ),
                );
            }
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
            }
          }
          const usageStr = formatResultUsageStats(r, r.model);
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
          }
          return container;
        }

        let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
        if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
        if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
        if (r.outputPath) text += `\n${theme.fg("muted", `Output: ${r.outputPath}`)}`;
        else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
        else {
          text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
          if (displayItems.length > COLLAPSED_ITEM_COUNT)
            text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        }
        const usageStr = formatResultUsageStats(r, r.model);
        if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
        return new Text(text, 0, 0);
      }

      const aggregateUsage = (results: SingleResult[]) => {
        const total = createUsageTotalsWithTurns();
        for (const r of results) {
          addUsageTotalsWithTurns(total, r.usage);
          if (r.descendantUsage) addUsageTotals(total, r.descendantUsage);
        }
        return total;
      };

      if (details.mode === "chain") {
        const successCount = details.results.filter(
          (r) => getResultStatus(r) === "completed",
        ).length;
        const icon =
          successCount === details.results.length
            ? theme.fg("success", "✓")
            : theme.fg("error", "✗");

        if (expanded) {
          const container = new Container();
          container.addChild(
            new Text(
              icon +
                " " +
                theme.fg("toolTitle", theme.bold("chain ")) +
                theme.fg("accent", `${successCount}/${details.results.length} steps`),
              0,
              0,
            ),
          );

          for (const r of details.results) {
            const status = getResultStatus(r);
            const rIcon = statusIcon(status);
            const displayItems = getResultDisplayItems(r);
            const finalOutput = getResultOutput(r);

            container.addChild(new Spacer(1));
            container.addChild(
              new Text(
                `${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
                0,
                0,
              ),
            );
            container.addChild(
              new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0),
            );

            // Show tool calls
            for (const item of displayItems) {
              if (item.type === "toolCall") {
                container.addChild(
                  new Text(
                    theme.fg("muted", "→ ") +
                      formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                    0,
                    0,
                  ),
                );
              }
            }

            // Show final output as markdown
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
            }

            const stepUsage = formatResultUsageStats(r, r.model);
            if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
          }

          const usageStr = formatUsageStats(aggregateUsage(details.results));
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
          }
          return container;
        }

        // Collapsed view
        let text =
          icon +
          " " +
          theme.fg("toolTitle", theme.bold("chain ")) +
          theme.fg("accent", `${successCount}/${details.results.length} steps`);
        for (const r of details.results) {
          const status = getResultStatus(r);
          const rIcon = statusIcon(status);
          const displayItems = getResultDisplayItems(r);
          text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
          if (r.outputPath) text += `\n${theme.fg("muted", `Output: ${r.outputPath}`)}`;
          else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
          else text += `\n${renderDisplayItems(displayItems, 5)}`;
        }
        const usageStr = formatUsageStats(aggregateUsage(details.results));
        if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
        text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      if (details.mode === "parallel") {
        const statuses = details.results.map((r) => getResultStatus(r));
        const running = statuses.filter((status) => status === "running").length;
        const successCount = statuses.filter((status) => status === "completed").length;
        const failCount = statuses.filter((status) => status === "failed").length;
        const isRunning = running > 0;
        const icon = isRunning
          ? theme.fg("warning", "⏳")
          : failCount > 0
            ? theme.fg("warning", "◐")
            : theme.fg("success", "✓");
        const status = isRunning
          ? `${successCount + failCount}/${details.results.length} done, ${running} running`
          : `${successCount}/${details.results.length} tasks`;

        if (expanded && !isRunning) {
          const container = new Container();
          container.addChild(
            new Text(
              `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
              0,
              0,
            ),
          );

          for (const r of details.results) {
            const status = getResultStatus(r);
            const rIcon = statusIcon(status);
            const displayItems = getResultDisplayItems(r);
            const finalOutput = getResultOutput(r);

            container.addChild(new Spacer(1));
            container.addChild(
              new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
            );
            container.addChild(
              new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0),
            );

            // Show tool calls
            for (const item of displayItems) {
              if (item.type === "toolCall") {
                container.addChild(
                  new Text(
                    theme.fg("muted", "→ ") +
                      formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                    0,
                    0,
                  ),
                );
              }
            }

            // Show final output as markdown
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
            }

            const taskUsage = formatResultUsageStats(r, r.model);
            if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
          }

          const usageStr = formatUsageStats(aggregateUsage(details.results));
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
          }
          return container;
        }

        // Collapsed view (or still running)
        let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
        for (const r of details.results) {
          const status = getResultStatus(r);
          const rIcon = statusIcon(status);
          const displayItems = getResultDisplayItems(r);
          text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
          if (r.outputPath) text += `\n${theme.fg("muted", `Output: ${r.outputPath}`)}`;
          else if (displayItems.length === 0)
            text += `\n${theme.fg("muted", status === "running" ? "(running...)" : "(no output)")}`;
          else text += `\n${renderDisplayItems(displayItems, 5)}`;
        }
        if (!isRunning) {
          const usageStr = formatUsageStats(aggregateUsage(details.results));
          if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
        }
        if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
    },
  });
}
