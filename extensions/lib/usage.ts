import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

const PiUsageSchema = Type.Object({
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Optional(Type.Number({ minimum: 0 })),
  cacheWrite: Type.Optional(Type.Number({ minimum: 0 })),
  cost: Type.Object({
    total: Type.Number({ minimum: 0 }),
  }),
});

type PiUsage = Static<typeof PiUsageSchema>;

const SubagentUsageSchema = Type.Object({
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Optional(Type.Number({ minimum: 0 })),
  cacheWrite: Type.Optional(Type.Number({ minimum: 0 })),
  cost: Type.Number({ minimum: 0 }),
});

type SubagentUsage = Static<typeof SubagentUsageSchema>;

const PersistedSubagentResultSchema = Type.Object({
  agent: Type.String(),
  agentSource: Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("unknown")]),
  task: Type.String(),
  exitCode: Type.Number(),
  messages: Type.Array(Type.Unknown()),
  stderr: Type.String(),
  usage: SubagentUsageSchema,
  descendantUsage: Type.Optional(SubagentUsageSchema),
});

const PersistedSubagentDetailsSchema = Type.Object({
  usageVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  mode: Type.Union([Type.Literal("single"), Type.Literal("parallel"), Type.Literal("chain")]),
  agentScope: Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")]),
  projectAgentsDir: Type.Union([Type.String(), Type.Null()]),
  results: Type.Array(PersistedSubagentResultSchema),
});

export type PersistedSubagentDetails = Static<typeof PersistedSubagentDetailsSchema>;

export interface PersistedSubagentUsage {
  totals: UsageTotals;
  runs: number;
  recognized: boolean;
  warnings: string[];
}

export function createUsageTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
}

export function addUsageTotals(target: UsageTotals, source: UsageTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
}

export function parsePiUsage(value: unknown): UsageTotals | undefined {
  if (!Value.Check(PiUsageSchema, value)) return undefined;
  const usage: PiUsage = value;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    cost: usage.cost.total,
  };
}

export function parseSubagentUsage(value: unknown): UsageTotals | undefined {
  if (!Value.Check(SubagentUsageSchema, value)) return undefined;
  const usage: SubagentUsage = value;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    cost: usage.cost,
  };
}

export function getPersistedSubagentUsage(details: unknown): PersistedSubagentUsage {
  if (!Value.Check(PersistedSubagentDetailsSchema, details)) {
    return {
      totals: createUsageTotals(),
      runs: 0,
      recognized: false,
      warnings: ["Subagent details are malformed; subagent usage was not counted."],
    };
  }

  const persisted: PersistedSubagentDetails = details;
  const totals = createUsageTotals();
  for (const result of persisted.results) {
    const directUsage = parseSubagentUsage(result.usage);
    if (directUsage) addUsageTotals(totals, directUsage);
    const descendantUsage = parseSubagentUsage(result.descendantUsage);
    if (descendantUsage) addUsageTotals(totals, descendantUsage);
  }

  return {
    totals,
    runs: persisted.results.length,
    recognized: true,
    warnings:
      persisted.usageVersion === undefined || persisted.usageVersion < 2
        ? ["Nested usage is unavailable for legacy subagent records."]
        : persisted.usageVersion > 2
          ? [
              `Subagent details use unsupported usage version ${persisted.usageVersion}; nested usage may be unavailable.`,
            ]
          : [],
  };
}
