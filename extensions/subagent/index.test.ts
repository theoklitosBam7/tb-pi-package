import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { formatParallelSummary, getFinalOutput } from "./index.js";

// Minimal message fixtures. getFinalOutput only reads role and content
// part type/text, so these carry just what the behavior depends on.
const assistant = (text: string): Message =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as Message;
const assistantToolCallOnly = (): Message =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }],
  }) as Message;
const user = (text: string): Message => ({ role: "user", content: text }) as Message;
const toolResult = (): Message =>
  ({ role: "toolResult", content: [{ type: "text", text: "result" }] }) as Message;

describe("getFinalOutput", () => {
  it("returns the text of the last assistant message, ignoring earlier ones and user messages", () => {
    const messages = [user("hi"), assistant("first"), assistant("second")];
    expect(getFinalOutput(messages)).toBe("second");
  });

  it("returns an empty string when there is no assistant message", () => {
    expect(getFinalOutput([user("hi"), toolResult()])).toBe("");
  });

  it("returns an empty string for an empty message list", () => {
    expect(getFinalOutput([])).toBe("");
  });

  it("skips an assistant message that has only tool-call parts and returns the previous text", () => {
    // The real call site depends on this extraction. An assistant turn that
    // ends in a tool call (no trailing text) must not shadow an earlier
    // text-bearing assistant message.
    const messages = [assistant("real-output"), assistantToolCallOnly()];
    expect(getFinalOutput(messages)).toBe("real-output");
  });
});

describe("formatParallelSummary", () => {
  it("includes each task's complete output even when it exceeds 100 characters", () => {
    // Output is far longer than the old 100-char preview limit, with a marker
    // that only exists past position 100.
    const longOutput = "START".padEnd(200, "x") + "UNIQUE_END_MARKER_PAST_100_CHARS";
    const text = formatParallelSummary([{ agent: "reviewer", exitCode: 0, output: longOutput }]);

    // The whole output is present verbatim; no truncation and no "..." marker.
    expect(text).toContain(longOutput);
    expect(text).toContain("UNIQUE_END_MARKER_PAST_100_CHARS");
  });

  it("reports the success count and a per-agent status label", () => {
    const text = formatParallelSummary([
      { agent: "alpha", exitCode: 0, output: "ok-alpha" },
      { agent: "beta", exitCode: 1, output: "err-beta" },
    ]);

    expect(text).toContain("Parallel: 1/2 succeeded");
    expect(text).toContain("[alpha]");
    expect(text).toContain("ok-alpha");
    expect(text).toContain("[beta]");
    expect(text).toContain("err-beta");
  });

  it("shows (no output) for tasks that produced no text", () => {
    const text = formatParallelSummary([{ agent: "silent", exitCode: 0, output: "" }]);
    expect(text).toContain("(no output)");
  });

  it("reports N/N when every task succeeds", () => {
    const text = formatParallelSummary([
      { agent: "a", exitCode: 0, output: "x" },
      { agent: "b", exitCode: 0, output: "y" },
    ]);
    expect(text).toContain("Parallel: 2/2 succeeded");
  });

  it("reports 0/N and a failed label when every task fails", () => {
    const text = formatParallelSummary([{ agent: "a", exitCode: 2, output: "boom" }]);
    expect(text).toContain("Parallel: 0/1 succeeded");
    expect(text).toContain("[a] failed:");
  });

  it("does not throw on an empty results array", () => {
    expect(() => formatParallelSummary([])).not.toThrow();
    expect(formatParallelSummary([])).toContain("Parallel: 0/0 succeeded");
  });
});
