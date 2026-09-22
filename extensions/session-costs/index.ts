import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  addUsageTotals,
  createUsageTotals,
  getPersistedSubagentUsage,
  parseUsageTotals,
  type UsageTotals,
} from "../lib/usage.js";

export interface SessionUsageReport {
  main: UsageTotals;
  subagents: UsageTotals;
  subagentRuns: number;
  warnings: string[];
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 20,
    useGrouping: true,
  }).format(value);
}

function formatCost(value: number): string {
  return `$${(Object.is(value, -0) ? 0 : value).toFixed(4)}`;
}

function getPromptTokens(usage: UsageTotals): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

function getTotalTokens(usage: UsageTotals): number {
  return getPromptTokens(usage) + usage.output;
}

export function formatSessionCosts(report: SessionUsageReport): string {
  const combined = createUsageTotals();
  addUsageTotals(combined, report.main);
  addUsageTotals(combined, report.subagents);
  const lines = [
    "Session costs",
    "",
    "Main agent",
    `  Prompt: ${formatTokenCount(getPromptTokens(report.main))}`,
    `  Cached: ${formatTokenCount(report.main.cacheRead)}`,
    `  Cache writes: ${formatTokenCount(report.main.cacheWrite)}`,
    `  Output: ${formatTokenCount(report.main.output)}`,
    `  Total: ${formatTokenCount(getTotalTokens(report.main))}`,
    `  Cost: ${formatCost(report.main.cost)}`,
    "",
    "Subagents",
    `  Runs: ${formatTokenCount(report.subagentRuns)}`,
    `  Prompt: ${formatTokenCount(getPromptTokens(report.subagents))}`,
    `  Cached: ${formatTokenCount(report.subagents.cacheRead)}`,
    `  Cache writes: ${formatTokenCount(report.subagents.cacheWrite)}`,
    `  Output: ${formatTokenCount(report.subagents.output)}`,
    `  Total: ${formatTokenCount(getTotalTokens(report.subagents))}`,
    `  Cost: ${formatCost(report.subagents.cost)}`,
    "",
    "Combined",
    `  Total: ${formatTokenCount(getTotalTokens(combined))} tokens`,
    `  Cost: ${formatCost(combined.cost)}`,
  ];
  if (report.warnings.length > 0) {
    lines.push("", "Warnings", ...report.warnings.map((warning) => `  ${warning}`));
  }
  return lines.join("\n");
}

export function collectSessionUsage(entries: readonly SessionEntry[]): SessionUsageReport {
  const report: SessionUsageReport = {
    main: createUsageTotals(),
    subagents: createUsageTotals(),
    subagentRuns: 0,
    warnings: [],
  };

  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      const usage = parseUsageTotals(entry.usage, "pi");
      if (usage) addUsageTotals(report.main, usage);
      continue;
    }

    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") {
      const usage = parseUsageTotals(entry.message.usage, "pi");
      if (usage) addUsageTotals(report.main, usage);
    } else if (entry.message.role === "toolResult") {
      if (entry.message.toolName === "agent") {
        const subagentUsage = getPersistedSubagentUsage(entry.message.details);
        if (subagentUsage.recognized) {
          addUsageTotals(report.subagents, subagentUsage.totals);
          report.subagentRuns += subagentUsage.runs;
        } else {
          const usage = parseUsageTotals(entry.message.usage, "pi");
          if (usage) addUsageTotals(report.main, usage);
        }
        for (const warning of subagentUsage.warnings) {
          if (!report.warnings.includes(warning)) report.warnings.push(warning);
        }
      } else {
        const usage = parseUsageTotals(entry.message.usage, "pi");
        if (usage) addUsageTotals(report.main, usage);
      }
    }
  }

  return report;
}

type SessionCostsCommandContext = {
  sessionManager: Pick<ExtensionCommandContext["sessionManager"], "getEntries">;
  ui: Pick<ExtensionCommandContext["ui"], "notify">;
};

export function executeSessionCostsCommand(ctx: SessionCostsCommandContext): void {
  const report = collectSessionUsage(ctx.sessionManager.getEntries());
  ctx.ui.notify(formatSessionCosts(report), report.warnings.length > 0 ? "warning" : "info");
}

export default function sessionCostsExtension(pi: Pick<ExtensionAPI, "registerCommand">): void {
  pi.registerCommand("session-costs", {
    description: "Show main-agent and subagent token and cost usage",
    handler: async (_args, ctx) => executeSessionCostsCommand(ctx),
  });
}
