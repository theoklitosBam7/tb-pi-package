import { expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagentExtension from "./index.js";

function setup() {
  const handlers = new Map<string, Set<(value: unknown) => void>>();
  const events = {
    on(channel: string, handler: (value: unknown) => void) {
      const listeners = handlers.get(channel) ?? new Set();
      listeners.add(handler);
      handlers.set(channel, listeners);
      return () => listeners.delete(handler);
    },
    emit(channel: string, value: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(value);
    },
  };
  const messages: unknown[] = [];
  const lifecycle: Record<string, (...args: never[]) => Promise<void>> = {};
  const tools: Record<string, { name: string; execute: (...args: never[]) => Promise<unknown> }> =
    {};
  events.on("workbench.inspection.v1.publish", (value) => messages.push(value));
  subagentExtension({
    events,
    on(name: string, handler: (...args: never[]) => Promise<void>) {
      lifecycle[name] = handler;
    },
    registerTool(tool: { name: string; execute: (...args: never[]) => Promise<unknown> }) {
      tools[tool.name] = tool;
    },
    registerCommand() {},
    registerShortcut() {},
  } as unknown as ExtensionAPI);
  const attach = (requestId: string) =>
    events.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "attach",
      requestId,
      generation: "host",
    });
  return { messages, lifecycle, attach, tools, handlers };
}

it("answers an inspection attachment before any tool call", () => {
  const { messages, attach } = setup();
  attach("first");
  expect(messages).toMatchObject([{ kind: "snapshot", activities: [] }]);
});

it("replaces the provider when the session changes before any manager exists", async () => {
  const { messages, lifecycle, attach } = setup();
  const context = (sessionId: string) =>
    ({ sessionManager: { getSessionId: () => sessionId } }) as never;
  await lifecycle.session_start({} as never, context("old"));
  attach("first");
  const first = messages[0] as { epoch: string };
  await lifecycle.session_start({} as never, context("new"));
  attach("second");
  expect(messages).toHaveLength(2);
  expect((messages[1] as { epoch: string }).epoch).not.toBe(first.epoch);
});

it("replaces the session owner without retaining an old request listener", async () => {
  const { messages, lifecycle, attach, tools, handlers } = setup();
  const context = (sessionId: string) =>
    ({ sessionManager: { getSessionId: () => sessionId } }) as never;
  await tools.agent_status.execute(
    "call" as never,
    {} as never,
    undefined as never,
    undefined as never,
    context("old"),
  );
  attach("first");
  const first = messages[0] as { epoch: string };
  await lifecycle.session_start({} as never, context("new"));
  attach("second");
  expect(messages).toHaveLength(2);
  expect(messages[1]).toMatchObject({ kind: "snapshot", activities: [] });
  expect((messages[1] as { epoch: string }).epoch).not.toBe(first.epoch);
  expect(handlers.get("workbench.inspection.v1.request")?.size).toBe(1);
  await lifecycle.session_shutdown();
  expect(handlers.get("workbench.inspection.v1.request")?.size).toBe(0);
});

it("stops answering after shutdown and starts a fresh epoch on session start", async () => {
  vi.useFakeTimers();
  try {
    const { messages, lifecycle, attach } = setup();
    attach("first");
    const first = messages[0] as { epoch: string };
    await lifecycle.session_shutdown();
    attach("after-shutdown");
    vi.runAllTimers();
    expect(messages).toHaveLength(1);
    await lifecycle.session_start(
      {} as never,
      { sessionManager: { getSessionId: () => "new" } } as never,
    );
    attach("after-start");
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ kind: "snapshot", activities: [] });
    expect((messages[1] as { epoch: string }).epoch).not.toBe(first.epoch);
  } finally {
    vi.useRealTimers();
  }
});
