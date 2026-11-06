import { describe, expect, it, vi } from "vitest";
import { createRunManager, type RunJob, type RunManager, type RunResult } from "./run-manager.js";

const owner = { sessionId: "session-a", generation: 1 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function job(
  agent: string,
  execute: RunJob["execute"] = async () => ({ artifactPath: `/artifacts/${agent}.md` }),
): RunJob {
  return { agent, task: `Task for ${agent}`, execute };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition was not reached");
}

describe("RunManager", () => {
  it("schedules a batch atomically within the bounded queue", async () => {
    const manager = createRunManager({ ...owner, concurrency: 1, maxQueued: 1 });
    const gate = deferred<{ artifactPath: string }>();
    const first = await manager.scheduleBatch({ ...owner, jobs: [job("one", () => gate.promise)] });
    expect(first.kind).toBe("scheduled");

    const second = await manager.scheduleBatch({ ...owner, jobs: [job("two")] });
    const overflow = await manager.scheduleBatch({ ...owner, jobs: [job("three"), job("four")] });

    expect(second.kind).toBe("scheduled");
    expect(overflow).toEqual({ kind: "rejected", reason: "queue-full" });
    expect((await manager.listRuns(owner)).map((run) => run.agent)).toEqual(["one", "two"]);
    gate.resolve({ artifactPath: "/artifacts/one.md" });
    await waitFor(
      async () =>
        (
          await manager.getRun({
            ...owner,
            runId: first.kind === "scheduled" ? first.runs[0].id : "",
          })
        )?.state.kind === "completed",
    );
  });

  it("cancels queued work without starting it", async () => {
    const manager = createRunManager({ ...owner, concurrency: 1, maxQueued: 2 });
    const gate = deferred<{ artifactPath: string }>();
    const first = await manager.scheduleBatch({
      ...owner,
      jobs: [job("active", () => gate.promise)],
    });
    const queuedExecute = vi.fn(async () => ({ artifactPath: "/never.md" }));
    const queued = await manager.scheduleBatch({ ...owner, jobs: [job("queued", queuedExecute)] });
    if (first.kind !== "scheduled" || queued.kind !== "scheduled")
      throw new Error("Expected scheduled runs");

    expect(await manager.cancelRun({ ...owner, runId: queued.runs[0].id })).toBe(true);
    expect(queuedExecute).not.toHaveBeenCalled();
    expect((await manager.getRun({ ...owner, runId: queued.runs[0].id }))?.state.kind).toBe(
      "aborted",
    );
    gate.resolve({ artifactPath: "/active.md" });
  });

  it("rejects operations from a foreign session and a stale generation", async () => {
    const manager = createRunManager(owner);
    const result = await manager.scheduleBatch({ ...owner, jobs: [job("owned")] });
    if (result.kind !== "scheduled") throw new Error("Expected scheduled run");

    await expect(
      manager.getRun({ sessionId: "session-b", generation: 1, runId: result.runs[0].id }),
    ).rejects.toThrow("owner");
    await manager.reset({ sessionId: "session-a", generation: 2 });
    await expect(manager.getRun({ ...owner, runId: result.runs[0].id })).rejects.toThrow(
      "generation",
    );
  });

  it("delivers accepted steering and preserves report and terminal outcomes", async () => {
    const manager = createRunManager(owner);
    const received = deferred<string>();
    const finish = deferred<{ artifactPath: string }>();
    const result = await manager.scheduleBatch({
      ...owner,
      jobs: [
        job("worker", async ({ registerControl, report }) => {
          registerControl(async (message) => received.resolve(message.content));
          await report("progress");
          return finish.promise;
        }),
      ],
    });
    if (result.kind !== "scheduled") throw new Error("Expected scheduled run");
    const runId = result.runs[0].id;
    const accepted = await manager.sendMessage({
      ...owner,
      runId,
      content: "Please focus on tests",
      mode: "steer",
    });
    expect(accepted.kind).toBe("accepted");
    expect(await received.promise).toBe("Please focus on tests");
    expect((await manager.getRun({ ...owner, runId }))?.reports).toEqual(["progress"]);

    finish.resolve({ artifactPath: "/artifacts/worker.md" });
    await waitFor(
      async () => (await manager.getRun({ ...owner, runId }))?.state.kind === "completed",
    );
    const terminal = await manager.getRun({ ...owner, runId });
    expect(terminal?.state).toEqual({
      kind: "completed",
      result: { artifactPath: "/artifacts/worker.md" },
    });
    expect(terminal?.messages[0].outcome).toBe("accepted-by-child");
  });

  it("serializes settlement against message acceptance and emits one terminal notification", async () => {
    const onNotification = vi.fn();
    const manager: RunManager = createRunManager({ ...owner, onNotification });
    const result = await manager.scheduleBatch({ ...owner, jobs: [job("instant")] });
    if (result.kind !== "scheduled") throw new Error("Expected scheduled run");
    const runId = result.runs[0].id;
    await waitFor(
      async () => (await manager.getRun({ ...owner, runId }))?.state.kind === "completed",
    );

    expect(
      await manager.sendMessage({ ...owner, runId, content: "Too late", mode: "follow_up" }),
    ).toEqual({ kind: "rejected", reason: "terminal" });
    expect(onNotification.mock.calls.filter(([event]) => event.type === "terminal")).toHaveLength(
      1,
    );
    expect((await manager.getRun({ ...owner, runId }))?.messages).toEqual([]);
  });

  it("keeps a cancelled run active until cleanup returns its final artifact", async () => {
    const manager = createRunManager({ ...owner, concurrency: 1 });
    const cleanup = deferred<{ artifactPath: string }>();
    const nextStarted = vi.fn();
    const first = await manager.scheduleBatch({
      ...owner,
      jobs: [
        job("cancelled", () => cleanup.promise),
        job("next", async () => {
          nextStarted();
          return { artifactPath: "/next.md" };
        }),
      ],
    });
    if (first.kind !== "scheduled") throw new Error("Expected scheduled runs");
    const [cancelled, next] = first.runs;
    expect(await manager.cancelRun({ ...owner, runId: cancelled.id })).toBe(true);
    expect((await manager.getRun({ ...owner, runId: cancelled.id }))?.state.kind).toBe("stopping");
    expect(nextStarted).not.toHaveBeenCalled();

    cleanup.resolve({ artifactPath: "/cancelled-final.md" });
    await waitFor(
      async () => (await manager.getRun({ ...owner, runId: next.id }))?.state.kind === "completed",
    );
    expect((await manager.getRun({ ...owner, runId: cancelled.id }))?.state).toEqual({
      kind: "aborted",
      result: { artifactPath: "/cancelled-final.md" },
    });
    expect(nextStarted).toHaveBeenCalledTimes(1);
  });

  it("waits for cleanup on reset and suppresses notifications from the old owner", async () => {
    const onNotification = vi.fn();
    const manager = createRunManager({ ...owner, onNotification });
    const cleanup = deferred<{ artifactPath: string }>();
    const result = await manager.scheduleBatch({
      ...owner,
      jobs: [job("active", () => cleanup.promise)],
    });
    if (result.kind !== "scheduled") throw new Error("Expected scheduled run");

    let resetFinished = false;
    const reset = manager.reset({ sessionId: "session-b", generation: 2 }).then(() => {
      resetFinished = true;
    });
    await Promise.resolve();
    expect(resetFinished).toBe(false);
    cleanup.resolve({ artifactPath: "/final.md" });
    await reset;

    expect(
      await manager.getRun({ sessionId: "session-b", generation: 2, runId: result.runs[0].id }),
    ).toBeUndefined();
    expect(onNotification.mock.calls.filter(([event]) => event.type === "terminal")).toHaveLength(
      0,
    );
  });

  it("rejects message and cancel requests for a run owned by the prior generation", async () => {
    const manager = createRunManager(owner);
    const cleanup = deferred<{ artifactPath: string }>();
    const result = await manager.scheduleBatch({
      ...owner,
      jobs: [job("active", () => cleanup.promise)],
    });
    if (result.kind !== "scheduled") throw new Error("Expected scheduled run");
    const runId = result.runs[0].id;
    const reset = manager.reset({ sessionId: "session-b", generation: 2 });

    expect(
      await manager.sendMessage({
        sessionId: "session-b",
        generation: 2,
        runId,
        content: "Do not reach the old run",
        mode: "steer",
      }),
    ).toEqual({ kind: "rejected", reason: "not-found" });
    expect(await manager.cancelRun({ sessionId: "session-b", generation: 2, runId })).toBe(false);
    expect(await manager.getRun({ sessionId: "session-b", generation: 2, runId })).toBeUndefined();

    cleanup.resolve({ artifactPath: "/final.md" });
    await reset;
  });

  it("bounds message acceptance and records rejected content as no outcome", async () => {
    const manager = createRunManager({ ...owner, maxMessagesPerRun: 1, maxMessageLength: 5 });
    const hold = deferred<{ artifactPath: string }>();
    const result = await manager.scheduleBatch({
      ...owner,
      jobs: [job("worker", () => hold.promise)],
    });
    if (result.kind !== "scheduled") throw new Error("Expected scheduled run");
    const runId = result.runs[0].id;

    expect(
      await manager.sendMessage({ ...owner, runId, content: "123456", mode: "steer" }),
    ).toEqual({ kind: "rejected", reason: "message-too-long" });
    expect(
      (await manager.sendMessage({ ...owner, runId, content: "hello", mode: "steer" })).kind,
    ).toBe("accepted");
    expect(
      await manager.sendMessage({ ...owner, runId, content: "again", mode: "follow_up" }),
    ).toEqual({ kind: "rejected", reason: "message-limit" });
    expect((await manager.getRun({ ...owner, runId }))?.messages).toHaveLength(1);
    hold.resolve({ artifactPath: "/worker.md" });
  });

  it("marks an accepted message undelivered when queued work is cancelled", async () => {
    const manager = createRunManager({ ...owner, concurrency: 1 });
    const finish = deferred<RunResult>();
    const active = await manager.scheduleBatch({
      ...owner,
      jobs: [job("active", () => finish.promise)],
    });
    const queued = await manager.scheduleBatch({
      ...owner,
      jobs: [job("queued")],
    });
    if (active.kind !== "scheduled" || queued.kind !== "scheduled")
      throw new Error("Expected scheduled runs");

    const message = await manager.sendMessage({
      ...owner,
      runId: queued.runs[0].id,
      content: "Please include the result",
      mode: "follow_up",
    });
    expect(message.kind).toBe("accepted");
    expect(await manager.cancelRun({ ...owner, runId: queued.runs[0].id })).toBe(true);
    expect((await manager.getRun({ ...owner, runId: queued.runs[0].id }))?.messages).toMatchObject([
      { content: "Please include the result", outcome: "undelivered" },
    ]);
    finish.resolve({ artifactPath: "/active.md" });
  });

  it.each([
    ["completion", { status: "completed" as const }],
    ["failure", { status: "failed" as const, error: "Child exited" }],
    ["timeout", { status: "timed-out" as const, error: "Deadline exceeded" }],
    ["abort", { status: "aborted" as const }],
  ])("marks an accepted undelivered message after %s", async (_name, result) => {
    const manager = createRunManager(owner);
    const finish = deferred<RunResult>();
    const scheduled = await manager.scheduleBatch({
      ...owner,
      jobs: [job("worker", () => finish.promise)],
    });
    if (scheduled.kind !== "scheduled") throw new Error("Expected scheduled run");
    const runId = scheduled.runs[0].id;
    const message = await manager.sendMessage({
      ...owner,
      runId,
      content: "Check the final result",
      mode: "follow_up",
    });
    expect(message.kind).toBe("accepted");
    finish.resolve(result);

    await waitFor(async () => {
      const run = await manager.getRun({ ...owner, runId });
      return run?.state.kind !== "running" && run?.state.kind !== "queued";
    });

    expect((await manager.getRun({ ...owner, runId }))?.messages).toMatchObject([
      { content: "Check the final result", outcome: "undelivered" },
    ]);
  });

  it("rejects oversized and excess reports without duplicating notifications", async () => {
    const onNotification = vi.fn();
    const manager = createRunManager({
      ...owner,
      maxReportsPerRun: 1,
      maxReportLength: 5,
      onNotification,
    });
    const finish = deferred<RunResult>();
    const scheduled = await manager.scheduleBatch({
      ...owner,
      jobs: [
        job("worker", async ({ report }) => {
          expect(await report("too long")).toBe(false);
          expect(await report("first")).toBe(true);
          expect(await report("second")).toBe(false);
          return finish.promise;
        }),
      ],
    });
    if (scheduled.kind !== "scheduled") throw new Error("Expected scheduled run");
    const runId = scheduled.runs[0].id;
    await waitFor(async () => (await manager.getRun({ ...owner, runId }))?.reports.length === 1);
    expect((await manager.getRun({ ...owner, runId }))?.reports).toEqual(["first"]);
    expect(onNotification.mock.calls.filter(([event]) => event.type === "report")).toHaveLength(1);

    finish.resolve({ artifactPath: "/worker.md" });
    await waitFor(
      async () => (await manager.getRun({ ...owner, runId }))?.state.kind === "completed",
    );
  });

  it("does not announce an artifact path when finalization fails", async () => {
    const onNotification = vi.fn();
    const manager = createRunManager({ ...owner, onNotification });
    const scheduled = await manager.scheduleBatch({
      ...owner,
      jobs: [job("worker", async () => ({ status: "failed", error: "Artifact write failed" }))],
    });
    if (scheduled.kind !== "scheduled") throw new Error("Expected scheduled run");
    const runId = scheduled.runs[0].id;

    await waitFor(async () => (await manager.getRun({ ...owner, runId }))?.state.kind === "failed");

    expect((await manager.getRun({ ...owner, runId }))?.state).toEqual({
      kind: "failed",
      error: "Artifact write failed",
      result: { status: "failed", error: "Artifact write failed" },
    });
    expect(onNotification.mock.calls.filter(([event]) => event.type === "terminal")).toMatchObject([
      [{ artifactPath: undefined }],
    ]);
  });

  it("retains only the newest 50 terminal runs and keeps active runs", async () => {
    const manager = createRunManager({ ...owner, concurrency: 1 });
    let oldestRunId = "";
    for (let index = 0; index < 51; index += 1) {
      const result = await manager.scheduleBatch({ ...owner, jobs: [job(`worker-${index}`)] });
      if (result.kind !== "scheduled") throw new Error("Expected scheduled run");
      if (index === 0) oldestRunId = result.runs[0].id;
      const runId = result.runs[0].id;
      await waitFor(async () => {
        const run = await manager.getRun({ ...owner, runId });
        return run?.state.kind === "completed";
      });
    }

    const activeCleanup = deferred<{ artifactPath: string }>();
    const active = await manager.scheduleBatch({
      ...owner,
      jobs: [job("active", () => activeCleanup.promise)],
    });
    if (active.kind !== "scheduled") throw new Error("Expected scheduled run");
    const runs = await manager.listRuns(owner);
    expect(runs).toHaveLength(51);
    expect(runs.some((run) => run.id === oldestRunId)).toBe(false);
    expect(runs.some((run) => run.id === active.runs[0].id && run.state.kind === "running")).toBe(
      true,
    );
    await manager.cancelRun({ ...owner, runId: active.runs[0].id });
    activeCleanup.resolve({ artifactPath: "/active-final.md" });
  });
});
