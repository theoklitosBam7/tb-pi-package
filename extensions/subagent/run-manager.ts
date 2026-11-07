export type RunState =
  | { kind: "queued" }
  | { kind: "running" }
  | { kind: "stopping" }
  | { kind: "completed"; result: RunResult }
  | { kind: "failed"; error: string; result?: RunResult }
  | { kind: "aborted"; result?: RunResult }
  | { kind: "timed-out"; error: string; result?: RunResult };

export interface RunResult {
  status?: "completed" | "failed" | "aborted" | "timed-out";
  artifactPath?: string;
  error?: string;
  value?: unknown;
}

export interface RunMessage {
  id: string;
  content: string;
  mode: "steer" | "follow_up";
  /** `accepted-by-child` confirms transport acceptance, not model consumption. */
  outcome: "pending" | "accepted-by-child" | "undelivered";
}

export interface RunSnapshot {
  id: string;
  agent: string;
  task: string;
  state: RunState;
  reports: string[];
  messages: RunMessage[];
}

export interface RunControlMessage {
  id: string;
  content: string;
  mode: "steer" | "follow_up";
}

export interface RunContext {
  runId: string;
  signal: AbortSignal;
  report(content: string): Promise<boolean>;
  registerControl(handler: (message: RunControlMessage) => void | Promise<void>): () => void;
}

export interface RunJob {
  agent: string;
  task: string;
  execute(context: RunContext): Promise<RunResult>;
}

export type RunNotification =
  | { type: "report"; runId: string; agent: string; eventId: string; content: string }
  | {
      type: "terminal";
      runId: string;
      agent: string;
      eventId: string;
      state: RunState;
      artifactPath?: string;
    };

export type ScheduleResult =
  | { kind: "scheduled"; runs: RunSnapshot[] }
  | { kind: "rejected"; reason: "queue-full" | "empty-batch" };

export type SendMessageResult =
  | { kind: "accepted"; messageId: string; outcome: "pending" }
  | { kind: "rejected"; reason: "not-found" | "terminal" | "message-limit" | "message-too-long" };

export interface RunOwner {
  sessionId: string;
  generation: number;
}

export interface RunManager extends RunOwner {
  scheduleBatch(input: RunOwner & { jobs: RunJob[] }): Promise<ScheduleResult>;
  listRuns(input: RunOwner): Promise<RunSnapshot[]>;
  getRun(input: RunOwner & { runId: string }): Promise<RunSnapshot | undefined>;
  sendMessage(
    input: RunOwner & { runId: string; content: string; mode: "steer" | "follow_up" },
  ): Promise<SendMessageResult>;
  cancelRun(input: RunOwner & { runId: string }): Promise<boolean>;
  reset(input: RunOwner): Promise<void>;
}

interface RunManagerOptions extends RunOwner {
  concurrency?: number;
  maxQueued?: number;
  maxReportsPerRun?: number;
  maxReportLength?: number;
  maxMessagesPerRun?: number;
  maxMessageLength?: number;
  cleanupTimeoutMs?: number;
  onNotification?: (notification: RunNotification) => void;
}

interface InternalRun extends RunSnapshot {
  job: RunJob;
  controller: AbortController;
  handler?: (message: RunControlMessage) => void | Promise<void>;
  terminal: boolean;
  eventSequence: number;
  queueSequence: number;
  deliveryScheduled: Set<string>;
  deliveryTail: Promise<void>;
  owner: RunOwner;
  notificationSuppressed: boolean;
  completion?: Promise<void>;
}

const MAX_CONCURRENCY = 4;
const MAX_QUEUED = 32;
const MAX_REPORTS = 32;
const MAX_REPORT_LENGTH = 8_000;
const MAX_MESSAGES = 32;
const MAX_MESSAGE_LENGTH = 8_000;
const MAX_TERMINAL_RUNS = 50;

export function createRunManager(options: RunManagerOptions): RunManager {
  let currentOwner: RunOwner = { sessionId: options.sessionId, generation: options.generation };
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? MAX_CONCURRENCY, MAX_CONCURRENCY),
  );
  const maxQueued = Math.max(0, Math.min(options.maxQueued ?? MAX_QUEUED, MAX_QUEUED));
  const maxReportsPerRun = Math.max(
    0,
    Math.min(options.maxReportsPerRun ?? MAX_REPORTS, MAX_REPORTS),
  );
  const maxReportLength = Math.max(
    1,
    Math.min(options.maxReportLength ?? MAX_REPORT_LENGTH, MAX_REPORT_LENGTH),
  );
  const maxMessagesPerRun = Math.max(
    0,
    Math.min(options.maxMessagesPerRun ?? MAX_MESSAGES, MAX_MESSAGES),
  );
  const maxMessageLength = Math.max(
    1,
    Math.min(options.maxMessageLength ?? MAX_MESSAGE_LENGTH, MAX_MESSAGE_LENGTH),
  );
  const cleanupTimeoutMs = Math.max(1, options.cleanupTimeoutMs ?? 5_000);
  const runs = new Map<string, InternalRun>();
  let queueSequence = 0;
  let messageSequence = 0;

  const assertOwner = (owner: RunOwner): void => {
    if (owner.sessionId !== currentOwner.sessionId)
      throw new Error("Run manager session owner mismatch");
    if (owner.generation !== currentOwner.generation)
      throw new Error("Run manager generation mismatch");
  };

  const snapshot = (run: InternalRun): RunSnapshot => ({
    id: run.id,
    agent: run.agent,
    task: run.task,
    state: run.state,
    reports: [...run.reports],
    messages: run.messages.map((message) => ({ ...message })),
  });

  const notify = (
    run: InternalRun,
    notification: { type: "report"; content: string } | { type: "terminal"; state: RunState },
  ): void => {
    if (
      run.notificationSuppressed ||
      run.owner.sessionId !== currentOwner.sessionId ||
      run.owner.generation !== currentOwner.generation
    )
      return;
    run.eventSequence += 1;
    const eventId = `${run.id}:${run.eventSequence}`;
    try {
      if (notification.type === "report") {
        options.onNotification?.({ ...notification, runId: run.id, agent: run.agent, eventId });
      } else {
        const artifactPath =
          "result" in notification.state &&
          notification.state.result &&
          "artifactPath" in notification.state.result
            ? notification.state.result.artifactPath
            : undefined;
        options.onNotification?.({
          ...notification,
          runId: run.id,
          agent: run.agent,
          eventId,
          artifactPath,
        });
      }
    } catch {
      // Notifications are best-effort, but they must not break run settlement.
    }
  };

  const findRun = (runId: string): InternalRun | undefined => runs.get(runId);
  const isOwnedRun = (run: InternalRun, owner: RunOwner): boolean =>
    !run.notificationSuppressed &&
    run.owner.sessionId === owner.sessionId &&
    run.owner.generation === owner.generation;

  const markPendingMessagesUndelivered = (run: InternalRun): void => {
    for (const message of run.messages) {
      if (message.outcome === "pending") message.outcome = "undelivered";
    }
  };

  const pruneTerminalRuns = (): void => {
    const terminalRuns = [...runs.values()].filter((run) => run.terminal);
    for (const run of terminalRuns.slice(0, Math.max(0, terminalRuns.length - MAX_TERMINAL_RUNS))) {
      runs.delete(run.id);
    }
  };

  const settle = (run: InternalRun, state: RunState): void => {
    if (run.terminal) return;
    run.terminal = true;
    run.state = state;
    markPendingMessagesUndelivered(run);
    notify(run, { type: "terminal", state });
    pruneTerminalRuns();
  };

  const deliverPending = (run: InternalRun): void => {
    const handler = run.handler;
    if (!handler || run.terminal || run.state.kind === "stopping") return;
    for (const message of run.messages) {
      if (message.outcome !== "pending" || run.deliveryScheduled.has(message.id)) continue;
      run.deliveryScheduled.add(message.id);
      const controlMessage: RunControlMessage = {
        id: message.id,
        content: message.content,
        mode: message.mode,
      };
      run.deliveryTail = run.deliveryTail.then(async () => {
        if (run.terminal || message.outcome !== "pending") return;
        try {
          await handler(controlMessage);
          if (!run.terminal && message.outcome === "pending") message.outcome = "accepted-by-child";
        } catch {
          if (!run.terminal && message.outcome === "pending") message.outcome = "undelivered";
        }
      });
    }
  };

  const runOne = async (run: InternalRun): Promise<void> => {
    if (run.terminal) return;
    run.state = { kind: "running" };
    const context: RunContext = {
      runId: run.id,
      signal: run.controller.signal,
      report: async (content) => {
        if (
          run.terminal ||
          run.reports.length >= maxReportsPerRun ||
          content.length > maxReportLength
        )
          return false;
        run.reports.push(content);
        notify(run, { type: "report", content });
        return true;
      },
      registerControl: (handler) => {
        run.handler = handler;
        deliverPending(run);
        return () => {
          if (run.handler === handler) run.handler = undefined;
        };
      },
    };

    try {
      const result = await run.job.execute(context);
      if (run.controller.signal.aborted) {
        settle(run, { kind: "aborted", result });
        return;
      }
      const status = result.status ?? "completed";
      switch (status) {
        case "completed":
          settle(run, { kind: "completed", result });
          break;
        case "failed":
          settle(run, { kind: "failed", error: result.error ?? "Run failed", result });
          break;
        case "aborted":
          settle(run, { kind: "aborted", result });
          break;
        case "timed-out":
          settle(run, { kind: "timed-out", error: result.error ?? "Run timed out", result });
          break;
        default: {
          const _exhaustive: never = status;
          void _exhaustive;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settle(
        run,
        run.controller.signal.aborted ? { kind: "aborted" } : { kind: "failed", error: message },
      );
    }
  };

  const pump = (): void => {
    const activeCount = [...runs.values()].filter(
      (run) => !run.terminal && run.state.kind !== "queued",
    ).length;
    if (activeCount >= concurrency) return;
    const next = [...runs.values()]
      .filter((run) => !run.terminal && run.state.kind === "queued")
      .sort((left, right) => left.queueSequence - right.queueSequence)[0];
    if (!next) return;
    next.completion = runOne(next).finally(pump);
    if (activeCount + 1 < concurrency) pump();
  };

  const manager: RunManager = {
    get sessionId() {
      return currentOwner.sessionId;
    },
    get generation() {
      return currentOwner.generation;
    },
    async scheduleBatch(input) {
      assertOwner(input);
      if (input.jobs.length === 0) return { kind: "rejected", reason: "empty-batch" };
      const queuedCount = [...runs.values()].filter(
        (run) => !run.terminal && run.state.kind === "queued",
      ).length;
      const immediatelyStartable = Math.max(
        0,
        concurrency -
          [...runs.values()].filter((run) => !run.terminal && run.state.kind !== "queued").length,
      );
      if (Math.max(0, input.jobs.length - immediatelyStartable) + queuedCount > maxQueued) {
        return { kind: "rejected", reason: "queue-full" };
      }
      const created = input.jobs.map((job) => {
        const run: InternalRun = {
          id: crypto.randomUUID(),
          agent: job.agent,
          task: job.task,
          job,
          state: { kind: "queued" },
          reports: [],
          messages: [],
          controller: new AbortController(),
          terminal: false,
          eventSequence: 0,
          queueSequence: queueSequence++,
          deliveryScheduled: new Set(),
          deliveryTail: Promise.resolve(),
          owner: { ...currentOwner },
          notificationSuppressed: false,
        };
        runs.set(run.id, run);
        return run;
      });
      pump();
      return { kind: "scheduled", runs: created.map(snapshot) };
    },
    async listRuns(input) {
      assertOwner(input);
      return [...runs.values()].filter((run) => isOwnedRun(run, input)).map(snapshot);
    },
    async getRun(input) {
      assertOwner(input);
      const run = findRun(input.runId);
      if (!run || !isOwnedRun(run, input)) return undefined;
      return snapshot(run);
    },
    async sendMessage(input) {
      assertOwner(input);
      const run = findRun(input.runId);
      if (!run || !isOwnedRun(run, input)) return { kind: "rejected", reason: "not-found" };
      if (run.terminal || run.state.kind === "stopping")
        return { kind: "rejected", reason: "terminal" };
      if (input.content.length > maxMessageLength)
        return { kind: "rejected", reason: "message-too-long" };
      if (run.messages.length >= maxMessagesPerRun)
        return { kind: "rejected", reason: "message-limit" };
      const message: RunMessage = {
        id: `message-${++messageSequence}`,
        content: input.content,
        mode: input.mode,
        outcome: "pending",
      };
      run.messages.push(message);
      deliverPending(run);
      return { kind: "accepted", messageId: message.id, outcome: "pending" };
    },
    async cancelRun(input) {
      assertOwner(input);
      const run = findRun(input.runId);
      if (!run || !isOwnedRun(run, input) || run.terminal) return false;
      run.controller.abort();
      if (run.state.kind === "queued") {
        settle(run, { kind: "aborted" });
        pump();
      } else {
        run.state = { kind: "stopping" };
      }
      return true;
    },
    async reset(input) {
      currentOwner = { sessionId: input.sessionId, generation: input.generation };
      const cleanup: Promise<void>[] = [];
      for (const run of runs.values()) {
        if (run.terminal) continue;
        run.notificationSuppressed = true;
        run.controller.abort();
        markPendingMessagesUndelivered(run);
        if (run.state.kind === "queued") settle(run, { kind: "aborted" });
        else {
          run.state = { kind: "stopping" };
          if (run.completion) cleanup.push(run.completion);
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cleanupTimedOut = false;
      await Promise.race([
        Promise.allSettled(cleanup),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            cleanupTimedOut = true;
            resolve();
          }, cleanupTimeoutMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (!cleanupTimedOut) {
        for (const run of runs.values()) {
          if (!run.terminal && run.state.kind === "stopping") settle(run, { kind: "aborted" });
        }
      }
    },
  };

  return manager;
}
