import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { UsageTotals, UsageTotalsWithTurns } from "../lib/usage.js";
import type { SubagentThinkingLevel } from "./overrides.js";

interface AbortableProcess {
  kill(signal: NodeJS.Signals): boolean;
}

export function installAbortHandler(options: {
  signal: AbortSignal;
  process: AbortableProcess;
  isClosed: () => boolean;
  timeoutMs?: number;
  onAbort?: () => void;
}): () => void {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.timeoutMs ?? 5000;
  const abort = () => {
    options.onAbort?.();
    options.process.kill("SIGTERM");
    timeout = setTimeout(() => {
      if (!options.isClosed()) options.process.kill("SIGKILL");
    }, timeoutMs);
  };

  if (options.signal.aborted) abort();
  else options.signal.addEventListener("abort", abort, { once: true });

  return () => {
    if (timeout !== undefined) clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
  };
}

export interface UsageStats extends UsageTotalsWithTurns {
  contextTokens: number;
}

export interface ResultDisplayItem {
  type: "toolCall";
  name: string;
  args: Record<string, unknown>;
}

export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  descendantUsage?: UsageTotals;
  descendantRuns?: number;
  model?: string;
  thinking?: SubagentThinkingLevel;
  systemPromptOverridden?: boolean;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  outputPath?: string;
  displayItems?: ResultDisplayItem[];
}

function sanitizeArtifactName(value: string): string {
  return value.replace(/[^\w.-]+/g, "_");
}

export function buildArtifactPath(options: {
  sessionFile: string;
  toolCallId: string;
  mode: "single" | "parallel" | "chain";
  index?: number;
  agent: string;
}): string {
  const sessionStem = path.basename(options.sessionFile, path.extname(options.sessionFile));
  const artifactDir = path.join(path.dirname(options.sessionFile), sessionStem);
  const index = options.index === undefined ? "" : `-${options.index.toString().padStart(2, "0")}`;
  const fileName = `${sanitizeArtifactName(options.toolCallId)}-${options.mode}${index}-${sanitizeArtifactName(options.agent)}.md`;
  return path.join(artifactDir, fileName);
}

function getResultSummaryStatus(
  result: Pick<SingleResult, "exitCode" | "stopReason">,
): "completed" | "failed" | "aborted" {
  if (result.stopReason === "aborted") return "aborted";
  return getResultStatus(result) === "completed" ? "completed" : "failed";
}

function formatArtifactMarkdown(options: {
  agent: string;
  status: "completed" | "failed" | "aborted";
  model?: string;
  exitCode: number;
  stopReason?: string;
  taskLabel: string;
  startedAt: string;
  finishedAt: string;
  output: string;
  errorMessage?: string;
  stderr?: string;
}): string {
  const lines = [
    "# Subagent result",
    "",
    `- Agent: ${options.agent}`,
    `- Status: ${options.status}`,
    `- Model: ${options.model ?? "unknown"}`,
    `- Exit code: ${options.exitCode}`,
    ...(options.stopReason ? [`- Stop reason: ${options.stopReason}`] : []),
    `- Task: ${options.taskLabel}`,
    `- Started: ${options.startedAt}`,
    `- Finished: ${options.finishedAt}`,
    "",
    "## Result",
    "",
    options.output || "(no output)",
    "",
  ];
  if (options.errorMessage || options.stderr) {
    lines.push("## Failure diagnostics", "");
    if (options.errorMessage) {
      lines.push("### Error message", "", options.errorMessage, "");
    }
    if (options.stderr) {
      lines.push("### Stderr", "", options.stderr, "");
    }
  }
  return lines.join("\n");
}

function getToolCallDisplayItems(messages: Message[]): ResultDisplayItem[] {
  const items: ResultDisplayItem[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "toolCall") {
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

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const text = msg.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n");
      if (text) return text;
    }
  }
  return "";
}

export interface ParallelSummaryItem {
  agent: string;
  outputPath: string;
  exitCode: number;
  stopReason?: string;
}

export function formatSingleSummary(
  result: Pick<SingleResult, "exitCode" | "stopReason">,
  outputPath: string,
): string {
  return `Agent ${getResultSummaryStatus(result)}. Read this file before continuing: ${outputPath}`;
}

export function formatChainSummary(
  results: Array<Pick<SingleResult, "outputPath" | "exitCode" | "stopReason">>,
): string {
  return results
    .map((result, index) => {
      const status = getResultSummaryStatus(result);
      const marker = index === results.length - 1 ? " (final)" : "";
      return `Step ${index + 1} ${status}${marker}. Read this file before continuing: ${result.outputPath}`;
    })
    .join("\n");
}

export function formatParallelSummary(results: ParallelSummaryItem[]): string {
  const successCount = results.filter((result) => getResultStatus(result) === "completed").length;
  const lines = results.map((result) => {
    const status = getResultSummaryStatus(result);
    return `[${result.agent}] ${status}. Read this file before continuing: ${result.outputPath}`;
  });
  return `Parallel: ${successCount}/${results.length} succeeded\n\n${lines.join("\n")}`;
}

export function getResultOutput(result: Pick<SingleResult, "messages" | "outputPath">): string {
  if (result.outputPath) {
    try {
      return fs.readFileSync(result.outputPath, "utf-8");
    } catch {
      return `Artifact unavailable: ${result.outputPath}`;
    }
  }
  return getFinalOutput(result.messages);
}

export function getResultStatus(
  result: Pick<SingleResult, "exitCode" | "stopReason">,
): "running" | "completed" | "failed" {
  if (result.exitCode === -1) return "running";
  if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
    return "failed";
  }
  return "completed";
}

export function isCompletedResult(result: Pick<SingleResult, "exitCode" | "stopReason">): boolean {
  return getResultStatus(result) === "completed";
}

function getFailureDiagnostics(result: Pick<SingleResult, "errorMessage" | "stderr">): {
  errorMessage?: string;
  stderr?: string;
} {
  return {
    errorMessage: result.errorMessage || undefined,
    stderr: result.stderr || undefined,
  };
}

export async function writeResultArtifact(options: {
  result: SingleResult;
  outputPath: string;
  taskLabel: string;
  startedAt: string;
}): Promise<string> {
  const { result, outputPath } = options;
  const status = getResultSummaryStatus(result);
  const finalOutput = getFinalOutput(result.messages);
  const displayItems = getToolCallDisplayItems(result.messages);
  const diagnostics = status === "completed" ? {} : getFailureDiagnostics(result);
  const markdown = formatArtifactMarkdown({
    agent: result.agent,
    status,
    model: result.model,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    taskLabel: options.taskLabel,
    startedAt: options.startedAt,
    finishedAt: new Date().toISOString(),
    output: finalOutput,
    ...diagnostics,
  });
  const artifactDir = path.dirname(outputPath);
  const tempPath = path.join(
    artifactDir,
    `.${path.basename(outputPath)}.${crypto.randomUUID()}.tmp`,
  );
  await fs.promises.mkdir(artifactDir, { recursive: true, mode: 0o700 });
  await withFileMutationQueue(outputPath, async () => {
    try {
      await fs.promises.writeFile(tempPath, markdown, { encoding: "utf-8", mode: 0o600 });
      await fs.promises.rename(tempPath, outputPath);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true });
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to write subagent artifact ${outputPath}: ${message}`);
    }
  });
  result.outputPath = outputPath;
  result.displayItems = displayItems;
  result.messages = [];
  const diagnosticText = [diagnostics.errorMessage, diagnostics.stderr]
    .filter(Boolean)
    .join("\n\n");
  return finalOutput || diagnosticText || "(no output)";
}
