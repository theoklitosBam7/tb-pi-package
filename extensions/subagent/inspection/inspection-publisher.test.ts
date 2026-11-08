import { expect, it, vi } from "vitest";
import { AgentInspectorStore, type AgentInspectorStatus } from "./inspector.js";
import { createInspectionPublisher } from "./inspection-publisher.js";

function testBus() {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  return {
    on(channel: string, handler: (value: unknown) => void) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => set.delete(handler);
    },
    emit(channel: string, value: unknown) {
      for (const handler of listeners.get(channel) ?? []) handler(value);
    },
  };
}

class ObservedStore extends AgentInspectorStore {
  contentReads = 0;

  override snapshot() {
    const recordContentRead = () => this.contentReads++;
    return super.snapshot().map((run) => ({
      ...run,
      get responses() {
        recordContentRead();
        return run.responses;
      },
      get tools() {
        recordContentRead();
        return run.tools;
      },
    }));
  }
}

it("coalesces changes for 100ms and publishes the latest pending state", () => {
  vi.useFakeTimers();
  try {
    const events = testBus();
    const store = new AgentInspectorStore();
    const messages: unknown[] = [];
    events.on("workbench.inspection.v1.publish", (value) => messages.push(value));
    const publisher = createInspectionPublisher({ events, store });
    events.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "attach",
      requestId: "r",
      generation: "g",
    });
    const run = store.start({ agent: "scout", task: "task" });
    run.appendText("first");
    vi.advanceTimersByTime(99);
    run.appendText(" latest");
    expect(messages).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      kind: "batch",
      revision: 1,
      upserts: [{ items: [{ text: "first latest" }] }],
    });
    publisher.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("defers reading activity content until the coalesced publication", () => {
  vi.useFakeTimers();
  const store = new ObservedStore();
  const events = testBus();
  const messages: unknown[] = [];
  events.on("workbench.inspection.v1.publish", (value) => messages.push(value));
  const run = store.start({ agent: "scout", task: "task" });
  const publisher = createInspectionPublisher({ events, store });
  try {
    events.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "attach",
      requestId: "r",
      generation: "g",
    });
    store.contentReads = 0;
    for (let i = 0; i < 50; i++) run.appendText("x");
    vi.advanceTimersByTime(99);
    run.appendText(" latest");
    expect(store.contentReads).toBe(0);
    expect(messages).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(store.contentReads).toBeGreaterThan(0);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      kind: "batch",
      revision: 2,
      upserts: [{ items: [{ text: `${"x".repeat(50)} latest` }] }],
    });
  } finally {
    publisher.dispose();
    vi.useRealTimers();
  }
});

it("keeps content reads coalesced with an omitted terminal run and skips detached updates", () => {
  vi.useFakeTimers();
  const store = new ObservedStore();
  const terminalRun = store.start({ agent: "finished", task: "task" });
  terminalRun.finish("completed");
  for (let i = 0; i < 63; i++) store.start({ agent: `active-${i}`, task: "task" });
  const run = store.start({ agent: "streaming", task: "task" });
  const events = testBus();
  const messages: unknown[] = [];
  events.on("workbench.inspection.v1.publish", (value) => messages.push(value));
  const publisher = createInspectionPublisher({ events, store });
  const request = (kind: "attach" | "detach", requestId: string) =>
    events.emit("workbench.inspection.v1.request", {
      version: 1,
      kind,
      requestId,
      generation: "g",
    });
  try {
    request("attach", "r1");
    expect(messages[0]).toMatchObject({ kind: "snapshot", omittedActivities: 1 });
    store.contentReads = 0;
    run.appendText("first");
    run.appendText(" latest");
    expect(store.contentReads).toBe(0);
    expect(messages).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(messages[1]).toMatchObject({
      kind: "batch",
      revision: 2,
      upserts: [{ title: "streaming", items: [{ text: "first latest" }] }],
      omittedActivities: 1,
    });
    run.appendText(" pending");
    request("detach", "r2");
    store.contentReads = 0;
    run.appendText(" detached");
    vi.advanceTimersByTime(100);
    expect(store.contentReads).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(messages).toHaveLength(2);
    request("attach", "r3");
    expect(messages[2]).toMatchObject({
      kind: "snapshot",
      revision: 3,
      activities: expect.arrayContaining([
        expect.objectContaining({
          title: "streaming",
          items: [
            {
              kind: "response",
              sequence: 1,
              text: "first latest pending detached",
              truncated: false,
            },
          ],
        }),
      ]),
      omittedActivities: 1,
    });
    expect(messages).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    publisher.dispose();
    vi.useRealTimers();
  }
});

it("replaces generations, ignores stale detach, and commits pending state on reattach", () => {
  vi.useFakeTimers();
  try {
    const events = testBus();
    const store = new AgentInspectorStore();
    const messages: unknown[] = [];
    events.on("workbench.inspection.v1.publish", (value) => messages.push(value));
    const publisher = createInspectionPublisher({ events, store });
    const request = (kind: "attach" | "detach", requestId: string, generation: string) =>
      events.emit("workbench.inspection.v1.request", { version: 1, kind, requestId, generation });
    request("attach", "r1", "g1");
    const run = store.start({ agent: "scout", task: "task" });
    run.appendText("pending");
    request("attach", "r2", "g2");
    expect(messages[1]).toMatchObject({
      kind: "snapshot",
      generation: "g2",
      revision: 1,
      activities: [{ items: [{ text: "pending" }] }],
    });
    expect(vi.getTimerCount()).toBe(0);
    request("detach", "r3", "g1");
    run.appendText(" updated");
    vi.advanceTimersByTime(100);
    expect(messages[2]).toMatchObject({
      kind: "batch",
      generation: "g2",
      revision: 2,
      upserts: [{ items: [{ text: "pending updated" }] }],
    });
    request("detach", "r4", "g2");
    run.appendText(" detached");
    expect(vi.getTimerCount()).toBe(0);
    request("attach", "r5", "g3");
    expect(messages[3]).toMatchObject({
      kind: "snapshot",
      generation: "g3",
      revision: 3,
      activities: [{ items: [{ text: "pending updated detached" }] }],
    });
    publisher.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("clears a pending publication and request listener on disposal", () => {
  vi.useFakeTimers();
  try {
    const events = testBus();
    const store = new AgentInspectorStore();
    const messages: unknown[] = [];
    events.on("workbench.inspection.v1.publish", (value) => messages.push(value));
    const publisher = createInspectionPublisher({ events, store });
    const attach = { version: 1, kind: "attach", requestId: "r", generation: "g" };
    events.emit("workbench.inspection.v1.request", attach);
    const run = store.start({ agent: "scout", task: "task" });
    expect(vi.getTimerCount()).toBe(1);
    publisher.dispose();
    expect(vi.getTimerCount()).toBe(0);
    run.appendText("after disposal");
    events.emit("workbench.inspection.v1.request", attach);
    vi.advanceTimersByTime(100);
    expect(messages).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it("ignores captured store callbacks after detach and disposal", () => {
  vi.useFakeTimers();
  const store = new AgentInspectorStore();
  const subscribe = store.subscribe.bind(store);
  let captured: (() => void) | undefined;
  const spy = vi.spyOn(store, "subscribe").mockImplementation((listener) => {
    captured = listener;
    return subscribe(listener);
  });
  try {
    const events = testBus();
    const messages: unknown[] = [];
    events.on("workbench.inspection.v1.publish", (value) => messages.push(value));
    const publisher = createInspectionPublisher({ events, store });
    events.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "attach",
      requestId: "r1",
      generation: "g",
    });
    events.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "detach",
      requestId: "r2",
      generation: "g",
    });
    captured?.();
    expect(vi.getTimerCount()).toBe(0);
    events.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "attach",
      requestId: "r3",
      generation: "g",
    });
    publisher.dispose();
    captured?.();
    vi.advanceTimersByTime(100);
    expect(vi.getTimerCount()).toBe(0);
    expect(messages).toHaveLength(2);
  } finally {
    spy.mockRestore();
    vi.useRealTimers();
  }
});

it("publishes removal when retained runs are cleared", () => {
  vi.useFakeTimers();
  try {
    const events = testBus();
    const store = new AgentInspectorStore();
    const run = store.start({ agent: "scout", task: "task" });
    run.finish("completed");
    const messages: unknown[] = [];
    events.on("workbench.inspection.v1.publish", (value) => messages.push(value));
    const publisher = createInspectionPublisher({ events, store });
    events.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "attach",
      requestId: "r",
      generation: "g",
    });
    store.clear();
    vi.advanceTimersByTime(100);
    expect(messages[1]).toMatchObject({
      kind: "batch",
      revision: 2,
      upserts: [],
      removals: ["run-1"],
      omittedActivities: 0,
    });
    publisher.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("does not capture detached changes and recovers after a coalesced capture failure", () => {
  vi.useFakeTimers();
  const store = new AgentInspectorStore();
  const snapshot = vi.spyOn(store, "snapshot");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const events = testBus();
    const messages: unknown[] = [];
    events.on("workbench.inspection.v1.publish", (value) => messages.push(value));
    const publisher = createInspectionPublisher({ events, store });
    const run = store.start({ agent: "scout", task: "task" });
    expect(snapshot).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    events.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "attach",
      requestId: "r1",
      generation: "g",
    });
    expect(() => run.appendText("visible")).not.toThrow();
    snapshot.mockImplementationOnce(() => {
      throw new Error("private payload");
    });
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(warning).toHaveBeenCalledExactlyOnceWith("Inspection publication failed.");
    expect(messages).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    events.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "attach",
      requestId: "r2",
      generation: "g",
    });
    expect(messages[1]).toMatchObject({
      kind: "snapshot",
      revision: 2,
      activities: [{ items: [{ text: "visible" }] }],
    });
    vi.advanceTimersByTime(100);
    expect(messages).toHaveLength(2);
    publisher.dispose();
  } finally {
    snapshot.mockRestore();
    warning.mockRestore();
    vi.useRealTimers();
  }
});

it("removes an evicted activity and upserts its replacement atomically", () => {
  vi.useFakeTimers();
  try {
    const events = testBus();
    const store = new AgentInspectorStore();
    for (let i = 0; i < 64; i++) store.start({ agent: `agent-${i}`, task: "task" });
    const messages: unknown[] = [];
    events.on("workbench.inspection.v1.publish", (value) => messages.push(value));
    const publisher = createInspectionPublisher({ events, store });
    events.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "attach",
      requestId: "r",
      generation: "g",
    });
    store.start({ agent: "new", task: "task" });
    vi.advanceTimersByTime(100);
    expect(messages[1]).toMatchObject({
      kind: "batch",
      revision: 2,
      upserts: [{ id: "run-65", title: "new" }],
      removals: ["run-1"],
      omittedActivities: 1,
    });
    publisher.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("publishes a snapshot only after attach and batches later changes", () => {
  vi.useFakeTimers();
  try {
    const handlers = new Map<string, Set<(value: unknown) => void>>();
    const events = {
      on(channel: string, handler: (value: unknown) => void) {
        const set = handlers.get(channel) ?? new Set();
        set.add(handler);
        handlers.set(channel, set);
        return () => set.delete(handler);
      },
      emit(channel: string, value: unknown) {
        for (const handler of handlers.get(channel) ?? []) handler(value);
      },
    };
    const store = new AgentInspectorStore();
    const messages: unknown[] = [];
    events.on("workbench.inspection.v1.publish", (value) => messages.push(value));
    const publisher = createInspectionPublisher({ events, store });
    const run = store.start({ agent: "scout", task: "task" });
    expect(messages).toEqual([]);
    events.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "attach",
      requestId: "req",
      generation: "gen",
    });
    expect(messages[0]).toMatchObject({
      kind: "snapshot",
      revision: 1,
      activities: [{ title: "scout" }],
    });
    run.appendText("visible");
    vi.advanceTimersByTime(100);
    expect(messages[1]).toMatchObject({
      kind: "batch",
      revision: 2,
      upserts: [{ items: [{ text: "visible" }] }],
    });
    publisher.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it.each<{ status: Exclude<AgentInspectorStatus, "queued" | "running">; state: string }>([
  { status: "completed", state: "completed" },
  { status: "failed", state: "failed" },
  { status: "aborted", state: "aborted" },
  { status: "timed out", state: "timed-out" },
])(
  "flushes $status content before the first timer and detaches without stopping runs",
  ({ status, state }) => {
    vi.useFakeTimers();
    try {
      const listeners = new Map<string, Set<(v: unknown) => void>>();
      const events = {
        on(channel: string, handler: (v: unknown) => void) {
          const set = listeners.get(channel) ?? new Set();
          set.add(handler);
          listeners.set(channel, set);
          return () => set.delete(handler);
        },
        emit(channel: string, value: unknown) {
          for (const handler of listeners.get(channel) ?? []) handler(value);
        },
      };
      const store = new AgentInspectorStore();
      const messages: unknown[] = [];
      events.on("workbench.inspection.v1.publish", (v) => messages.push(v));
      const publisher = createInspectionPublisher({ events, store });
      events.emit("workbench.inspection.v1.request", {
        version: 1,
        kind: "attach",
        requestId: "r1",
        generation: "g",
      });
      const run = store.start({ agent: "scout", task: "task" });
      run.appendText("final");
      run.finish(status);
      expect(messages.at(-1)).toMatchObject({
        kind: "batch",
        upserts: [{ state, items: [{ text: "final" }] }],
      });
      expect(vi.getTimerCount()).toBe(0);
      events.emit("workbench.inspection.v1.request", {
        version: 1,
        kind: "detach",
        requestId: "r2",
        generation: "g",
      });
      store.start({ agent: "other", task: "task" });
      vi.advanceTimersByTime(100);
      expect(messages).toHaveLength(2);
      publisher.dispose();
    } finally {
      vi.useRealTimers();
    }
  },
);

it("recovers with a fresh snapshot after an observer throws", () => {
  const listeners = new Map<string, Set<(v: unknown) => void>>();
  const events = {
    on(channel: string, handler: (v: unknown) => void) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => set.delete(handler);
    },
    emit(channel: string, value: unknown) {
      for (const handler of listeners.get(channel) ?? []) handler(value);
    },
  };
  const store = new AgentInspectorStore();
  const published: unknown[] = [];
  let fail = true;
  events.on("workbench.inspection.v1.publish", (value) => {
    if (fail) throw new Error("secret payload");
    published.push(value);
  });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const publisher = createInspectionPublisher({ events, store });
    events.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "attach",
      requestId: "r1",
      generation: "g",
    });
    expect(warning).toHaveBeenCalledWith("Inspection publication failed.");
    fail = false;
    events.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "attach",
      requestId: "r2",
      generation: "g",
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: "snapshot", requestId: "r2", revision: 0 });
    publisher.dispose();
  } finally {
    warning.mockRestore();
  }
});

it("accepts a repeated attach when JSON object key order differs", () => {
  const listeners = new Map<string, Set<(v: unknown) => void>>();
  const events = {
    on(channel: string, handler: (v: unknown) => void) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => set.delete(handler);
    },
    emit(channel: string, value: unknown) {
      for (const handler of listeners.get(channel) ?? []) handler(value);
    },
  };
  const messages: unknown[] = [];
  events.on("workbench.inspection.v1.publish", (v) => messages.push(v));
  const publisher = createInspectionPublisher({ events, store: new AgentInspectorStore() });
  events.emit("workbench.inspection.v1.request", {
    version: 1,
    kind: "attach",
    requestId: "r",
    generation: "g",
  });
  events.emit("workbench.inspection.v1.request", {
    generation: "g",
    requestId: "r",
    kind: "attach",
    version: 1,
  });
  expect(messages).toHaveLength(2);
  publisher.dispose();
});
