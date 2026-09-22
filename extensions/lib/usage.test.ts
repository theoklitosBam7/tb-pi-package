import { describe, expect, it } from "vitest";
import {
  addUsageTotals,
  addUsageTotalsWithTurns,
  createUsageTotals,
  createUsageTotalsWithTurns,
  getPersistedSubagentUsage,
  hasUsageTotals,
  parsePiUsage,
  parseSubagentUsage,
} from "./usage.js";

describe("usage totals", () => {
  it("adds turn-aware totals and detects non-zero usage", () => {
    const target = createUsageTotalsWithTurns();
    addUsageTotalsWithTurns(target, {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      cost: 0.5,
      turns: 2,
    });

    expect(target).toEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      cost: 0.5,
      turns: 2,
    });
    expect(hasUsageTotals(target)).toBe(true);
    expect(hasUsageTotals(createUsageTotals())).toBe(false);
  });

  it("parses and adds billed Pi usage without changing the raw buckets", () => {
    const target = createUsageTotals();
    const usage = parsePiUsage({
      input: 100,
      output: 25,
      cacheRead: 40,
      cacheWrite: 5,
      totalTokens: 170,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0.003,
        cacheWrite: 0.001,
        total: 0.034,
      },
    });

    expect(usage).toEqual({
      input: 100,
      output: 25,
      cacheRead: 40,
      cacheWrite: 5,
      cost: 0.034,
    });
    addUsageTotals(target, usage!);
    expect(target).toEqual(usage);
  });

  it("parses subagent usage with a numeric cost and missing legacy cache fields", () => {
    expect(
      parseSubagentUsage({ input: 12, output: 8, cost: 0.25, contextTokens: 20, turns: 1 }),
    ).toEqual({
      input: 12,
      output: 8,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.25,
    });
  });

  it("rejects malformed usage without throwing", () => {
    expect(() => parseSubagentUsage({ input: "12" })).not.toThrow();
    expect(parseSubagentUsage({ input: "12" })).toBeUndefined();
    expect(parseSubagentUsage({ input: -1, output: 0, cost: 0 })).toBeUndefined();
    expect(parsePiUsage(null)).toBeUndefined();
  });

  it("sums direct and descendant usage and runs from a valid v3 subagent record", () => {
    expect(
      getPersistedSubagentUsage({
        usageVersion: 3,
        mode: "single",
        agentScope: "user",
        projectAgentsDir: null,
        results: [
          {
            agent: "worker",
            agentSource: "user",
            task: "task",
            exitCode: 0,
            messages: [],
            stderr: "",
            usage: {
              input: 10,
              output: 4,
              cacheRead: 2,
              cacheWrite: 1,
              cost: 0.5,
              contextTokens: 14,
              turns: 1,
            },
            descendantUsage: {
              input: 3,
              output: 2,
              cacheRead: 1,
              cacheWrite: 0,
              cost: 0.2,
            },
            descendantRuns: 3,
          },
        ],
      }),
    ).toEqual({
      totals: {
        input: 13,
        output: 6,
        cacheRead: 3,
        cacheWrite: 1,
        cost: 0.7,
      },
      runs: 4,
      recognized: true,
      warnings: [],
    });
  });

  it("reports legacy and malformed details without throwing", () => {
    const legacy = getPersistedSubagentUsage({
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [],
    });
    expect(legacy.recognized).toBe(true);
    expect(legacy.warnings).toContain("Nested usage is unavailable for legacy subagent records.");

    const future = getPersistedSubagentUsage({
      usageVersion: 4,
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [],
    });
    expect(future.recognized).toBe(true);
    expect(future.warnings).toContain(
      "Subagent details use unsupported usage version 4; nested usage may be unavailable.",
    );

    const malformed = getPersistedSubagentUsage({ results: "not-an-array" });
    expect(malformed.recognized).toBe(false);
    expect(malformed.runs).toBe(0);
    expect(malformed.warnings).toContain(
      "Subagent details are malformed; subagent usage was not counted.",
    );
  });
});
