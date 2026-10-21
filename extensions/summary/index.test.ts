import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSummaryConfig, saveSummaryConfig } from "./config.js";
import summaryExtension, {
  type SummaryContext,
  type SummaryEvents,
  type SummaryHost,
} from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const model: Model<"openai-responses"> = {
  id: "gpt-6-luna",
  name: "Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  input: ["text"],
  reasoning: true,
  contextWindow: 128000,
  maxTokens: 4096,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};
function response(
  text = "Changed: added an email check. Checks: passed. Unfinished: none.",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-6-luna",
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
    },
  };
}
async function harness(configPath?: string) {
  const directory = await mkdtemp(join(tmpdir(), "pi-summary-events-"));
  directories.push(directory);
  const handlers: Array<
    (event: SummaryEvents[keyof SummaryEvents], context: SummaryContext) => void | Promise<void>
  > = [];
  const session = SessionManager.inMemory();
  const notify = vi.fn();
  const select = vi.fn<SummaryContext["ui"]["select"]>().mockResolvedValue(undefined);
  const registerEntryRenderer = vi.fn();
  const streamSimple = vi
    .fn<SummaryContext["modelRegistry"]["streamSimple"]>()
    .mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: response() });
      stream.end();
      return stream;
    });
  const context: SummaryContext = {
    sessionManager: session,
    hasUI: true,
    modelRegistry: { find: () => model, getAvailable: () => [model], streamSimple },
    ui: { notify, select },
  };
  let command: Parameters<SummaryHost["registerCommand"]>[1] | undefined;
  const setModel = vi.fn();
  const setThinkingLevel = vi.fn();
  const host: SummaryHost & {
    setModel: typeof setModel;
    setThinkingLevel: typeof setThinkingLevel;
  } = {
    setModel,
    setThinkingLevel,
    on(name, handler) {
      handlers.push((event, context) => {
        // The event discriminant validates the callback's registered event type.
        if (event.type === name) return handler(event as SummaryEvents[typeof name], context);
      });
      return () => {};
    },
    registerCommand(_name, options) {
      command = options;
    },
    appendEntry(customType, data) {
      session.appendCustomEntry(customType, data);
    },
    registerEntryRenderer,
  };
  const path = configPath ?? join(directory, "summary.json");
  summaryExtension(host, path);
  async function emit<K extends keyof SummaryEvents>(event: SummaryEvents[K] & { type: K }) {
    for (const handler of handlers) await handler(event, context);
  }
  async function user(text = "Add an email check.") {
    const message = { role: "user", content: text, timestamp: 0 } satisfies Parameters<
      typeof session.appendMessage
    >[0];
    session.appendMessage(message);
    await emit({ type: "message_end", message });
  }
  function assistant(text = "Added the email check and ran the focused test.") {
    session.appendMessage(response(text));
  }
  return {
    emit,
    user,
    assistant,
    session,
    context,
    command: () => command,
    streamSimple,
    notify,
    select,
    registerEntryRenderer,
    setModel,
    setThinkingLevel,
    path,
  };
}

async function recapInProgress() {
  const app = await harness();
  const stream = createAssistantMessageEventStream();
  app.streamSimple.mockReturnValue(stream);
  await app.user();
  app.assistant();
  await app.emit({ type: "agent_settled", aborted: false });
  await vi.waitFor(() => expect(app.streamSimple).toHaveBeenCalled());
  return { app, stream, signal: app.streamSimple.mock.calls[0][2]?.signal };
}

describe("summary extension", () => {
  it("loads through Pi's real runtime and registers the summary command and renderer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-summary-loader-"));
    directories.push(directory);
    const result = await discoverAndLoadExtensions(
      [fileURLToPath(new URL("./index.ts", import.meta.url))],
      directory,
      directory,
    );
    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].commands.has("summary")).toBe(true);
    expect(result.extensions[0].entryRenderers?.has("summary")).toBe(true);
  });

  it.each(["retry", "automatic continuation"])(
    "preserves the pending task across a %s without another user message",
    async () => {
      const app = await harness();
      await app.emit({ type: "agent_start" });
      await app.user();
      app.assistant();
      await app.emit({ type: "agent_start" });
      app.assistant("Work completed after continuation.");
      await app.emit({ type: "agent_settled", aborted: false });
      await vi.waitFor(() =>
        expect(app.session.getBranch()).toContainEqual(
          expect.objectContaining({ type: "custom", customType: "summary" }),
        ),
      );
      expect(app.streamSimple).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["during", "after"])(
    "preserves the latest task when compaction occurs %s the work",
    async (timing) => {
      const app = await harness();
      await app.user("Old task request.");
      app.assistant("Old task work.");
      await app.user("Latest task request.");
      const requestId = app.session.getLeafId();
      app.assistant("Evidence before compaction.");
      if (timing === "during")
        app.session.appendCompaction("Compaction summary includes old work.", requestId, 100);
      app.assistant("Latest final response.");
      if (timing === "after")
        app.session.appendCompaction("Compaction summary includes old work.", requestId, 100);
      await app.emit({ type: "agent_settled", aborted: false });
      await vi.waitFor(() =>
        expect(app.session.getBranch()).toContainEqual(
          expect.objectContaining({ type: "custom", customType: "summary" }),
        ),
      );
      const record = app.streamSimple.mock.calls[0][1].messages[0].content;
      expect(record).toContain("Latest task request.");
      expect(record).toContain("Evidence before compaction.");
      expect(record).toContain("Latest final response.");
      expect(record).not.toContain("Old task");
      expect(record).not.toContain("Compaction summary");
      expect(app.streamSimple).toHaveBeenCalledTimes(1);
    },
  );

  it("automatically recaps a completed task with the exact default model and thinking", async () => {
    const app = await harness();
    await app.user();
    app.assistant();
    await app.emit({ type: "agent_settled", aborted: false });
    await vi.waitFor(() => expect(app.streamSimple).toHaveBeenCalled());
    expect(app.streamSimple).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", id: "gpt-6-luna" }),
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Add an email check."),
          }),
        ],
      }),
      expect.objectContaining({ reasoning: "medium", signal: expect.any(AbortSignal) }),
    );
    await vi.waitFor(() =>
      expect(app.session.getBranch()).toContainEqual(
        expect.objectContaining({
          type: "custom",
          customType: "summary",
          data: expect.objectContaining({
            text: expect.stringContaining("Changed: added an email check."),
          }),
        }),
      ),
    );
  });

  it("includes only work after the latest consumed user request", async () => {
    const app = await harness();
    await app.user("Old task: clean up the header.");
    app.assistant("Old header work.");
    await app.user("Latest task: fix signup.");
    app.assistant("New signup work.");
    await app.emit({ type: "agent_settled", aborted: false });
    await vi.waitFor(() => expect(app.streamSimple).toHaveBeenCalled());
    const prompt = app.streamSimple.mock.calls[0][1].messages[0].content;
    expect(prompt).toContain("Latest task: fix signup.");
    expect(prompt).toContain("New signup work.");
    expect(prompt).not.toContain("Old header work.");
    expect(prompt).not.toContain("Old task");
  });

  it("does not recap an aborted task, an unfinished task, or a final provider error", async () => {
    const app = await harness();
    await app.user();
    app.assistant();
    await app.emit({ type: "agent_settled", aborted: true });
    await app.user("No assistant work yet.");
    await app.emit({ type: "agent_settled", aborted: false });
    await app.user("Provider failed.");
    app.session.appendMessage({
      ...response(),
      stopReason: "error",
      errorMessage: "No credentials",
    });
    await app.emit({ type: "agent_settled", aborted: false });
    expect(app.streamSimple).not.toHaveBeenCalled();
  });

  it("does not block settlement while the recap model is running", async () => {
    const app = await harness();
    const stream = createAssistantMessageEventStream();
    app.streamSimple.mockReturnValue(stream);
    await app.user();
    app.assistant();
    let settled = false;
    const settling = app.emit({ type: "agent_settled", aborted: false }).then(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 200 });
    } finally {
      stream.end(response());
      await settling;
    }
  });

  it("aborts an obsolete recap and discards its late result when new work starts", async () => {
    const { app, stream, signal } = await recapInProgress();
    await app.user("Start a different task.");
    stream.end(response());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(signal?.aborted).toBe(true);
    expect(app.session.getBranch().filter((entry) => entry.type === "custom")).toEqual([]);
  });

  it("cancels recap work on runtime shutdown and prevents output into a replacement session", async () => {
    const { app, stream } = await recapInProgress();
    await app.emit({ type: "session_shutdown", reason: "new" });
    stream.end(response());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(app.streamSimple.mock.calls[0][2]?.signal?.aborted).toBe(true);
    expect(app.session.getBranch().filter((entry) => entry.type === "custom")).toEqual([]);
  });

  it("cancels a recap when the user changes the session branch", async () => {
    const { app, stream } = await recapInProgress();
    await app.emit({
      type: "session_tree",
      oldLeafId: app.session.getLeafId(),
      newLeafId: null,
      fromExtension: false,
    });
    stream.end(response());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(app.streamSimple.mock.calls[0][2]?.signal?.aborted).toBe(true);
    expect(app.session.getBranch().filter((entry) => entry.type === "custom")).toEqual([]);
  });

  it("cancels the previous recap when any new agent run starts", async () => {
    const { app, stream } = await recapInProgress();
    await app.emit({ type: "agent_start" });
    stream.end(response());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(app.streamSimple.mock.calls[0][2]?.signal?.aborted).toBe(true);
    expect(app.session.getBranch().filter((entry) => entry.type === "custom")).toEqual([]);
  });

  it("uses /summary only to save global model and supported thinking selections", async () => {
    const app = await harness();
    app.select.mockImplementation(async (_title, options) =>
      options.includes("high") ? "high" : options[0],
    );
    expect(app.command()).toBeDefined();
    await app.command()?.handler("", app.context);
    expect(await loadSummaryConfig(app.path)).toEqual({
      provider: "openai",
      model: "gpt-6-luna",
      thinking: "high",
    });
    expect(app.streamSimple).not.toHaveBeenCalled();
    await app.user();
    app.assistant();
    await app.emit({ type: "agent_settled", aborted: false });
    await vi.waitFor(() => expect(app.streamSimple).toHaveBeenCalled());
    expect(app.streamSimple.mock.calls[0][2]?.reasoning).toBe("high");
  });

  it("reports unsupported saved thinking without silently clamping or calling another model", async () => {
    const app = await harness();
    app.context.modelRegistry.find = () => ({ ...model, reasoning: false });
    await app.user();
    app.assistant();
    await app.emit({ type: "agent_settled", aborted: false });
    await vi.waitFor(() =>
      expect(app.notify).toHaveBeenCalledWith(
        expect.stringContaining("does not support thinking medium"),
        "error",
      ),
    );
    expect(app.streamSimple).not.toHaveBeenCalled();
  });

  it("sends task text and tool evidence without hidden thinking or image payloads", async () => {
    const app = await harness();
    const message = {
      role: "user",
      content: [
        { type: "text", text: "Fix signup." },
        { type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE_PAYLOAD" },
      ],
      timestamp: 0,
    } satisfies Parameters<typeof app.session.appendMessage>[0];
    app.session.appendMessage(message);
    await app.emit({ type: "message_end", message });
    app.session.appendMessage({
      ...response(),
      content: [
        { type: "thinking", thinking: "PRIVATE_REASONING" },
        { type: "toolCall", id: "check", name: "bash", arguments: { command: "pnpm test" } },
      ],
    });
    app.session.appendMessage({
      role: "toolResult",
      toolCallId: "check",
      toolName: "bash",
      content: [{ type: "text", text: "Focused check passed" }],
      isError: false,
      timestamp: 1,
    });
    app.assistant("Finished signup.");
    await app.emit({ type: "agent_settled", aborted: false });
    await vi.waitFor(() => expect(app.streamSimple).toHaveBeenCalled());
    const record = app.streamSimple.mock.calls[0][1].messages[0].content;
    expect(record).toContain("Focused check passed");
    expect(record).toContain("pnpm test");
    expect(record).not.toContain("PRIVATE_REASONING");
    expect(record).not.toContain("PRIVATE_IMAGE_PAYLOAD");
  });

  it("asks for a short bullet recap format", async () => {
    const app = await harness();
    await app.user();
    app.assistant();
    await app.emit({ type: "agent_settled", aborted: false });
    await vi.waitFor(() => expect(app.streamSimple).toHaveBeenCalled());
    const systemPrompt = app.streamSimple.mock.calls[0][1].systemPrompt;
    expect(systemPrompt).toContain("at most three short bullet points");
    expect(systemPrompt).toContain("changes, checks, and unfinished work");
  });

  it("respects context edits when building the latest task record", async () => {
    const app = await harness();
    await app.user();
    const id = app.session.appendMessage({
      role: "toolResult",
      toolCallId: "read",
      toolName: "read",
      content: [{ type: "text", text: "REDACTED_SECRET" }],
      isError: false,
      timestamp: 1,
    });
    app.session.appendContextEdit(id, { content: [{ type: "text", text: "Safe replacement" }] });
    app.assistant();
    await app.emit({ type: "agent_settled", aborted: false });
    await vi.waitFor(() => expect(app.streamSimple).toHaveBeenCalled());
    const record = app.streamSimple.mock.calls[0][1].messages[0].content;
    expect(record).toContain("Safe replacement");
    expect(record).not.toContain("REDACTED_SECRET");
  });

  it("bounds recap input and request duration while keeping the task and final result", async () => {
    const app = await harness();
    await app.user("Keep this task request.");
    app.session.appendMessage({
      role: "toolResult",
      toolCallId: "large",
      toolName: "read",
      content: [{ type: "text", text: "x".repeat(100000) }],
      isError: false,
      timestamp: 1,
    });
    app.assistant("Keep this final result.");
    await app.emit({ type: "agent_settled", aborted: false });
    await vi.waitFor(() => expect(app.streamSimple).toHaveBeenCalled());
    const record = app.streamSimple.mock.calls[0][1].messages[0].content;
    expect(typeof record === "string" ? record.length : Infinity).toBeLessThanOrEqual(48000);
    expect(record).toContain("Keep this task request.");
    expect(record).toContain("Keep this final result.");
    expect(record).toContain("[Task record truncated]");
    expect(app.streamSimple.mock.calls[0][2]).toMatchObject({
      timeoutMs: 60000,
      maxRetries: 0,
      maxTokens: 4096,
    });
  });

  it("stores one non-context recap with usage and does not recap its own output", async () => {
    const app = await harness();
    await app.user();
    app.assistant();
    await app.emit({ type: "agent_settled", aborted: false });
    await vi.waitFor(() =>
      expect(app.session.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(1),
    );
    await app.emit({ type: "agent_settled", aborted: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(app.streamSimple).toHaveBeenCalledTimes(1);
    expect(
      app.session
        .buildSessionProjection()
        .messages.map((message) => JSON.stringify(message))
        .join("\n"),
    ).not.toContain("Changed: added an email check.");
    expect(app.session.getBranch()).toContainEqual(
      expect.objectContaining({
        type: "custom",
        data: expect.objectContaining({ usage: response().usage }),
      }),
    );
  });

  it("renders the recap model, thinking level, and tokens", async () => {
    const app = await harness();
    const renderer = app.registerEntryRenderer.mock.calls[0][1] as (entry: {
      data: {
        text: string;
        provider: string;
        model: string;
        thinking: string;
        usage: { totalTokens: number };
      };
    }) => { render(width: number): string[] };
    const output = renderer({
      data: {
        text: "Changed: added an email check.",
        provider: "openai",
        model: "gpt-6-luna",
        thinking: "medium",
        usage: { totalTokens: 15 },
      },
    })
      .render(80)
      .join("\n");
    expect(output).toContain("openai/gpt-6-luna");
    expect(output).toContain("thinking medium");
    expect(output).toContain("15 tokens");
    expect(output).toContain("Changed: added an email check.");
  });

  it("prints the saved settings and path with /summary status", async () => {
    const app = await harness();
    await saveSummaryConfig(app.path, {
      provider: "anthropic",
      model: "example-model",
      thinking: "low",
    });
    await app.command()?.handler(" status ", app.context);
    expect(app.notify).toHaveBeenCalledWith(
      expect.stringContaining("anthropic/example-model, thinking low"),
      "info",
    );
    expect(app.notify).toHaveBeenCalledWith(expect.stringContaining(app.path), "info");
    expect(app.select).not.toHaveBeenCalled();
  });

  it("resets saved settings and repairs an invalid config with /summary reset", async () => {
    const app = await harness();
    await writeFile(app.path, "broken JSON");
    await app.command()?.handler("reset", app.context);
    expect(await loadSummaryConfig(app.path)).toEqual({
      provider: "openai",
      model: "gpt-6-luna",
      thinking: "medium",
    });
    expect(app.notify).toHaveBeenCalledWith(expect.stringContaining("reset"), "info");
    expect(app.select).not.toHaveBeenCalled();
  });

  it("reports an invalid config for /summary status", async () => {
    const app = await harness();
    await writeFile(app.path, "broken JSON");
    await app.command()?.handler("status", app.context);
    expect(app.notify).toHaveBeenCalledWith(
      expect.stringContaining("Summary status failed"),
      "error",
    );
    expect(app.select).not.toHaveBeenCalled();
  });

  it("preserves saved settings when either configuration picker is cancelled", async () => {
    const app = await harness();
    const saved = {
      provider: "openai",
      model: "gpt-6-luna",
      thinking: "high",
    } satisfies Parameters<typeof saveSummaryConfig>[1];
    await saveSummaryConfig(app.path, saved);
    await app.command()?.handler("", app.context);
    expect(await loadSummaryConfig(app.path)).toEqual(saved);
    app.select
      .mockImplementationOnce(async (_title, options) => options[0])
      .mockResolvedValueOnce(undefined);
    await app.command()?.handler("", app.context);
    expect(await loadSummaryConfig(app.path)).toEqual(saved);
    expect(app.streamSimple).not.toHaveBeenCalled();
  });

  it("reuses global selections in another extension instance without changing the active model", async () => {
    const first = await harness();
    first.select.mockImplementation(async (_title, options) =>
      options.includes("low") ? "low" : options[0],
    );
    await first.command()?.handler("", first.context);
    const next = await harness(first.path);
    await next.user();
    next.assistant();
    await next.emit({ type: "agent_settled", aborted: false });
    await vi.waitFor(() => expect(next.streamSimple).toHaveBeenCalled());
    expect(next.streamSimple.mock.calls[0][2]?.reasoning).toBe("low");
    expect(first.setModel).not.toHaveBeenCalled();
    expect(first.setThinkingLevel).not.toHaveBeenCalled();
    expect(next.setModel).not.toHaveBeenCalled();
    expect(next.setThinkingLevel).not.toHaveBeenCalled();
  });

  it("reports an unavailable configured model without fallback", async () => {
    const app = await harness();
    app.context.modelRegistry.find = () => undefined;
    await app.user();
    app.assistant();
    await app.emit({ type: "agent_settled", aborted: false });
    await vi.waitFor(() =>
      expect(app.notify).toHaveBeenCalledWith(
        expect.stringContaining("openai/gpt-6-luna is unavailable"),
        "error",
      ),
    );
    expect(app.streamSimple).not.toHaveBeenCalled();
  });

  it("reports each recap failure once per session", async () => {
    const app = await harness();
    app.context.modelRegistry.find = () => undefined;
    await app.user();
    app.assistant();
    await app.emit({ type: "agent_settled", aborted: false });
    await vi.waitFor(() => expect(app.notify).toHaveBeenCalledTimes(1));
    await app.user("Try the task again.");
    app.assistant();
    await app.emit({ type: "agent_settled", aborted: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(app.notify).toHaveBeenCalledTimes(1);
    await app.emit({ type: "session_shutdown", reason: "new" });
    await app.user("Start in a fresh session.");
    app.assistant();
    await app.emit({ type: "agent_settled", aborted: false });
    await vi.waitFor(() => expect(app.notify).toHaveBeenCalledTimes(2));
  });

  it("offers only off thinking for a non-reasoning model and omits reasoning from its request", async () => {
    const app = await harness();
    const fast = { ...model, id: "fast", reasoning: false };
    app.context.modelRegistry.getAvailable = () => [fast];
    app.context.modelRegistry.find = () => fast;
    app.select.mockImplementation(async (_title, options) => options[0]);
    await app.command()?.handler("", app.context);
    expect(app.select.mock.calls[1][1]).toEqual(["off"]);
    expect(await loadSummaryConfig(app.path)).toEqual({
      provider: "openai",
      model: "fast",
      thinking: "off",
    });
    await app.user();
    app.assistant();
    await app.emit({ type: "agent_settled", aborted: false });
    await vi.waitFor(() => expect(app.streamSimple).toHaveBeenCalled());
    expect(app.streamSimple.mock.calls[0][2]?.reasoning).toBeUndefined();
  });

  it("still publishes the recap when unrelated usage is appended to the same branch", async () => {
    const app = await harness();
    const stream = createAssistantMessageEventStream();
    app.streamSimple.mockReturnValue(stream);
    await app.user();
    app.assistant();
    await app.emit({ type: "agent_settled", aborted: false });
    await vi.waitFor(() => expect(app.streamSimple).toHaveBeenCalled());
    app.session.appendUsage("cache_warm", "openai", "gpt-6-luna", response().usage);
    stream.end(response());
    await vi.waitFor(() =>
      expect(app.session.getBranch()).toContainEqual(
        expect.objectContaining({ type: "custom", customType: "summary" }),
      ),
    );
  });

  it.each(["no-ui", "arguments", "no-models", "invalid-config"])(
    "reports configuration problems without opening an unusable picker: %s",
    async (problem) => {
      const app = await harness();
      if (problem === "no-ui") app.context.hasUI = false;
      if (problem === "no-models") app.context.modelRegistry.getAvailable = () => [];
      if (problem === "invalid-config") await writeFile(app.path, "broken JSON");
      await app.command()?.handler(problem === "arguments" ? "generate" : "", app.context);
      expect(app.notify).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringMatching(/error|warning/),
      );
      expect(app.select).not.toHaveBeenCalled();
      expect(app.streamSimple).not.toHaveBeenCalled();
    },
  );

  it.each(["error", "aborted", "length", "empty"])(
    "reports an unusable recap response: %s",
    async (reason) => {
      const app = await harness();
      const stream = createAssistantMessageEventStream();
      stream.end({
        ...response(reason === "empty" ? " " : "Partial recap"),
        stopReason:
          reason === "empty"
            ? "stop"
            : reason === "length"
              ? "length"
              : reason === "aborted"
                ? "aborted"
                : "error",
        errorMessage: "Provider response failed",
      });
      app.streamSimple.mockReturnValue(stream);
      await app.user();
      app.assistant();
      await app.emit({ type: "agent_settled", aborted: false });
      await vi.waitFor(() =>
        expect(app.notify).toHaveBeenCalledWith(
          expect.stringContaining("Automatic recap failed"),
          "error",
        ),
      );
      expect(app.session.getBranch().filter((entry) => entry.type === "custom")).toEqual([]);
    },
  );
});
