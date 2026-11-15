import * as os from "node:os";
import type { UsageTotals, UsageTotalsWithTurns } from "../lib/usage.js";
import { isRecord } from "./is-record.js";
import type { RunSnapshot, SendMessageResult } from "./run-manager.js";
import type { SubagentTermination } from "./result.js";

/** Model-facing cap for a full status report. It prevents a transcript-sized payload. */
export const MAX_STATUS_CHARS = 4_000;
const MAX_LIST_TASK_CHARS = 200;
const MAX_CARD_TASK_CHARS = 400;
const MAX_LIST_PREVIEW_CHARS = 160;
const REPORT_TEXT_BUDGET = 2_000;
const MAX_MESSAGE_CHARS = 200;
const MAX_MESSAGES = 8;

function stripAnsi(value: string): string {
  const escape = 27;
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== escape) {
      result += value[index];
      continue;
    }
    const next = value[index + 1];
    if (next === "[") {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code >= 64 && code <= 126) break;
        index += 1;
      }
    } else if (next === "]") {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        if (code === 7) break;
        if (code === escape && value[index + 1] === "\\") {
          index += 1;
          break;
        }
        index += 1;
      }
    }
  }
  return result;
}

function stripControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 9 || code === 10 || code >= 32) result += character;
  }
  return result;
}

export function sanitizeText(value: string): string {
  return stripControlCharacters(stripAnsi(value));
}

export type RunStatus =
  | "queued"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "aborted"
  | "timed out";

export interface RunSummaryMessage {
  id: string;
  mode: "steer" | "follow_up";
  outcome: "pending" | "accepted-by-child" | "undelivered";
  content: string;
}

export interface RunSummary {
  id: string;
  agent: string;
  task: string;
  status: RunStatus;
  reports: string[];
  reportCount: number;
  messages: RunSummaryMessage[];
  messageCount: number;
  artifactPath?: string;
  error?: string;
  usage?: UsageTotalsWithTurns & { contextTokens?: number };
  descendantUsage?: UsageTotals;
  termination?: SubagentTermination;
  preview?: string;
}

interface ResultFacts {
  usage?: UsageTotalsWithTurns & { contextTokens?: number };
  descendantUsage?: UsageTotals;
  termination?: SubagentTermination;
  preview?: string;
}

export function shortRunId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

export function shortPath(
  value: string,
  options: { home?: string; maxWidth?: number } = {},
): string {
  const home = options.home ?? os.homedir();
  const maxWidth = Math.max(8, options.maxWidth ?? 72);
  const displayed =
    home.length > 1 && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  if (displayed.length <= maxWidth) return displayed;
  const keep = maxWidth - 3;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${displayed.slice(0, head)}...${displayed.slice(displayed.length - tail)}`;
}

export type RunStatusColor = "success" | "warning" | "error";

const STATUS_PRESENTATION: Record<RunStatus, { symbol: string; color: RunStatusColor }> = {
  queued: { symbol: "·", color: "warning" },
  running: { symbol: "⏳", color: "warning" },
  stopping: { symbol: "■", color: "warning" },
  completed: { symbol: "✓", color: "success" },
  failed: { symbol: "✗", color: "error" },
  aborted: { symbol: "■", color: "error" },
  "timed out": { symbol: "✗", color: "error" },
};

export function statusSymbol(status: RunStatus): string {
  return STATUS_PRESENTATION[status].symbol;
}

export function statusColor(status: RunStatus): RunStatusColor {
  return STATUS_PRESENTATION[status].color;
}

export function formatRunState(status: RunStatus): string {
  return `${statusSymbol(status)} ${status}`;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
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
  if (model) parts.push(model);
  return parts.join(" ");
}

function runStatus(snapshot: RunSnapshot): RunStatus {
  return snapshot.state.kind === "timed-out" ? "timed out" : snapshot.state.kind;
}

function readResultFacts(snapshot: RunSnapshot): ResultFacts {
  if (!("result" in snapshot.state) || !snapshot.state.result) return {};
  const value = snapshot.state.result.value;
  if (!isRecord(value)) return {};
  const facts: ResultFacts = {};
  if (isRecord(value.usage)) facts.usage = value.usage as unknown as ResultFacts["usage"];
  if (isRecord(value.descendantUsage)) {
    facts.descendantUsage = value.descendantUsage as unknown as UsageTotals;
  }
  facts.termination = value.termination as SubagentTermination | undefined;
  if (typeof value.preview === "string") facts.preview = sanitizeText(value.preview);
  return facts;
}

function artifactPath(snapshot: RunSnapshot): string | undefined {
  if (!("result" in snapshot.state) || !snapshot.state.result) return undefined;
  return snapshot.state.result.artifactPath;
}

function capText(value: string, maxChars: number): string {
  const clean = sanitizeText(value).trim().replace(/\s+/g, " ");
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

function capReports(reports: string[]): string[] {
  const kept: string[] = [];
  let remaining = REPORT_TEXT_BUDGET;
  for (const report of reports) {
    if (remaining <= 0) break;
    const clean = sanitizeText(report).trim();
    if (!clean) continue;
    const text =
      clean.length <= remaining ? clean : `${clean.slice(0, Math.max(0, remaining - 1))}…`;
    kept.push(text);
    remaining -= text.length;
  }
  return kept;
}

export function toRunSummary(snapshot: RunSnapshot): RunSummary {
  const facts = readResultFacts(snapshot);
  const messages = snapshot.messages.slice(0, MAX_MESSAGES).map((message) => ({
    id: message.id,
    mode: message.mode,
    outcome: message.outcome,
    content: capText(message.content, MAX_MESSAGE_CHARS),
  }));
  const summary: RunSummary = {
    id: snapshot.id,
    agent: sanitizeText(snapshot.agent),
    task: sanitizeText(snapshot.task),
    status: runStatus(snapshot),
    reports: capReports(snapshot.reports),
    reportCount: snapshot.reports.length,
    messages,
    messageCount: snapshot.messages.length,
    artifactPath: artifactPath(snapshot),
    error: "error" in snapshot.state ? sanitizeText(snapshot.state.error) : undefined,
    usage: facts.usage,
    descendantUsage: facts.descendantUsage,
    termination: facts.termination,
    preview: facts.preview,
  };
  return summary;
}

function describeRuns(runs: RunSummary[]): string {
  const active = runs.filter(
    (run) => run.status === "queued" || run.status === "running" || run.status === "stopping",
  ).length;
  const completed = runs.filter((run) => run.status === "completed").length;
  const failed = runs.filter(
    (run) => run.status === "failed" || run.status === "timed out" || run.status === "aborted",
  ).length;
  return `${runs.length} run${runs.length === 1 ? "" : "s"} (${formatRunCounts({ active, completed, failed })})`;
}

export interface StatusFormatOptions {
  /** Shorten run IDs and paths for the transcript. Model content keeps the full values. */
  compact?: boolean;
}

function displayRunId(run: RunSummary, options: StatusFormatOptions): string {
  return options.compact ? shortRunId(run.id) : run.id;
}

function displayPath(value: string, options: StatusFormatOptions): string {
  return options.compact ? shortPath(value, { maxWidth: 80 }) : value;
}

function artifactLine(run: RunSummary, options: StatusFormatOptions): string {
  if (run.artifactPath) return `Artifact: ${displayPath(run.artifactPath, options)}`;
  if (run.status === "queued" || run.status === "running" || run.status === "stopping") {
    return "Artifact: none yet";
  }
  return "Artifact: none";
}

export function formatStatusList(runs: RunSummary[], options: StatusFormatOptions = {}): string {
  if (runs.length === 0) return "No asynchronous runs in this session.";
  const lines = [`agent_status: ${describeRuns(runs)}`];
  for (const run of runs) {
    const reports =
      run.reportCount > 0 ? ` · ${run.reportCount} report${run.reportCount === 1 ? "" : "s"}` : "";
    const usage = run.usage ? ` · ${formatUsage(run.usage)}` : "";
    lines.push(
      `- ${displayRunId(run, options)} ${formatRunState(run.status)} ${run.agent}${reports}${usage}`,
    );
    lines.push(`  Task: ${capText(run.task, MAX_LIST_TASK_CHARS)}`);
    lines.push(`  ${artifactLine(run, options)}`);
    if (run.preview) lines.push(`  Preview: ${capText(run.preview, MAX_LIST_PREVIEW_CHARS)}`);
  }
  return truncateStatus(lines, runs.length);
}

function truncateStatus(lines: string[], runCount: number): string {
  const text = lines.join("\n");
  if (text.length <= MAX_STATUS_CHARS) return text;
  const noticeReserve = 120;
  const budget = MAX_STATUS_CHARS - noticeReserve;
  const kept: string[] = [];
  let length = 0;
  let keptRuns = 0;
  for (const line of lines) {
    if (length + line.length + 1 > budget) break;
    kept.push(line);
    length += line.length + 1;
    if (line.startsWith("- ")) keptRuns += 1;
  }
  const omitted = runCount - keptRuns;
  if (omitted > 0) {
    kept.push(
      `... ${omitted} more run${omitted === 1 ? "" : "s"} omitted; pass a runId to inspect one.`,
    );
  }
  return kept.join("\n");
}

export function formatStatusCard(run: RunSummary, options: StatusFormatOptions = {}): string {
  const lines = [
    `agent_status: ${displayRunId(run, options)}`,
    `Agent: ${run.agent}`,
    `State: ${formatRunState(run.status)}`,
    `Task: ${capText(run.task, MAX_CARD_TASK_CHARS)}`,
    artifactLine(run, options),
  ];
  if (run.error) lines.push(`Error: ${run.error}`);
  const usage = run.usage ? formatUsage(run.usage) : "";
  if (usage) lines.push(`Usage: ${usage}`);
  if (run.descendantUsage) {
    const nested = formatUsage(run.descendantUsage);
    if (nested) lines.push(`Nested usage: ${nested}`);
  }
  if (run.termination?.kind === "watchdog") {
    lines.push(
      `Watchdog: ${run.termination.deadline} deadline (${run.termination.limitSeconds}s); cleanup ${run.termination.cleanup}`,
    );
  } else if (run.termination?.kind === "abort") {
    lines.push("Cleanup: unknown");
  }
  if (run.reportCount > 0) {
    lines.push(`Reports (${run.reportCount}):`);
    run.reports.forEach((report, index) => {
      const [first = "", ...rest] = report.split("\n");
      lines.push(`  ${index + 1}. ${first}`);
      for (const line of rest) lines.push(`     ${line}`);
    });
    const omitted = run.reportCount - run.reports.length;
    if (omitted > 0)
      lines.push(`  ... ${omitted} more report${omitted === 1 ? "" : "s"} (truncated)`);
  }
  if (run.messageCount > 0) {
    lines.push(`Messages (${run.messageCount}):`);
    for (const message of run.messages) {
      lines.push(`  - ${message.id} ${message.mode} ${message.outcome}: "${message.content}"`);
    }
    const omitted = run.messageCount - run.messages.length;
    if (omitted > 0) lines.push(`  ... ${omitted} more message${omitted === 1 ? "" : "s"}`);
  }
  if (run.preview) lines.push(`Preview: ${run.preview}`);
  return capCard(lines);
}

function capCard(lines: string[]): string {
  const text = lines.join("\n");
  if (text.length <= MAX_STATUS_CHARS) return text;
  const notice = "... output truncated; pass a runId to inspect one run.";
  const budget = MAX_STATUS_CHARS - notice.length - 1;
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > budget) break;
    kept.push(line);
    length += line.length + 1;
  }
  kept.push(notice);
  return kept.join("\n");
}

export function formatMissingRun(runId: string): string {
  return `No run found for ID ${runId}. It may have been pruned or belong to another session.`;
}

export function formatMissingRunCard(runId: string): string {
  return `agent_status: ${runId}\nState: ✗ not found`;
}

export function formatLaunchReport(runs: RunSummary[]): string {
  const lines = [
    `Started ${runs.length} asynchronous run${runs.length === 1 ? "" : "s"}.`,
    ...runs.map((run) => `- ${run.agent}: ${run.id} (${run.status})`),
    "Use agent_status to check progress.",
  ];
  return lines.join("\n");
}

const REJECTION_REASONS: Record<
  Extract<SendMessageResult, { kind: "rejected" }>["reason"],
  string
> = {
  "not-found": "was not found",
  terminal: "is already terminal",
  "message-limit": "has reached its message limit",
  "message-too-long": "has a message that is too long",
};

export function formatSendReport(options: {
  runId: string;
  mode: "steer" | "follow_up";
  result: SendMessageResult;
}): string {
  if (options.result.kind === "accepted") {
    return `Message ${options.result.messageId} accepted (${options.mode} → ${options.runId}). Delivery is pending.`;
  }
  return `Message rejected: run ${options.runId} ${REJECTION_REASONS[options.result.reason]}.`;
}

export function formatCancelReport(runId: string, canceled: boolean): string {
  return canceled
    ? `Run ${runId} canceled.`
    : `Run ${runId} could not be canceled: not found or already terminal.`;
}

export function formatRunCounts(counts: {
  active: number;
  completed: number;
  failed: number;
}): string {
  const parts = [`${counts.active} active`, `${counts.completed} completed`];
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  return parts.join(", ");
}

export function formatTerminalReport(options: {
  run: RunSummary;
  otherRuns: { active: number; completed: number; failed: number };
}): string {
  const { run, otherRuns } = options;
  const lines = [
    `${statusSymbol(run.status)} subagent ${run.agent} ${run.status}`,
    `  Run       ${run.id}`,
  ];
  if (run.artifactPath) lines.push(`  Artifact  ${run.artifactPath}`);
  const usage = run.usage ? formatUsage(run.usage) : "";
  if (usage) lines.push(`  Usage     ${usage}`);
  if (otherRuns.active + otherRuns.completed + otherRuns.failed > 0) {
    lines.push(`  Other runs: ${formatRunCounts(otherRuns)}`);
  }
  return lines.join("\n");
}

export function formatReportNotification(options: {
  agent: string;
  runId: string;
  content: string;
}): string {
  return `Subagent ${options.agent} report (run ${options.runId}):\n${sanitizeText(options.content)}`;
}
