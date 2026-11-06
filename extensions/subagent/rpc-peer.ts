import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

export type RpcCommand =
  | { type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string }
  | { type: "follow_up"; message: string }
  | { type: "abort" };

export type RpcResponse = {
  id: string;
  command: RpcCommand["type"];
  success: boolean;
  data?: unknown;
  error?: string;
};

export class RpcCommandError extends Error {
  constructor(readonly response: RpcResponse) {
    super(response.error ?? `RPC ${response.command} command was rejected`);
    this.name = "RpcCommandError";
  }
}

export type RpcPeer = {
  send(command: RpcCommand): Promise<RpcResponse>;
  acceptLine(record: unknown): "consumed" | "event";
  waitForSettled(signal?: AbortSignal): Promise<void>;
  fail(error: Error): void;
  close(): void;
};

type PendingResponse = {
  command: RpcCommand["type"];
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createRpcPeer(options: {
  stdin: Writable;
  commandTimeoutMs: number;
  maxPendingCommands?: number;
}): RpcPeer {
  const pending = new Map<string, PendingResponse>();
  const maxPendingCommands = options.maxPendingCommands ?? 16;
  let settled = false;
  let closed = false;
  let failure: Error | undefined;
  let writesInFlight = 0;
  let resolveSettled: (() => void) | undefined;
  let rejectSettled: ((error: Error) => void) | undefined;
  let writeQueue = Promise.resolve();
  const settledPromise = new Promise<void>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });
  void settledPromise.catch(() => {});

  const settleIfReady = () => {
    if (settled && pending.size === 0 && writesInFlight === 0) resolveSettled?.();
  };

  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    rejectSettled?.(error);
    for (const response of pending.values()) {
      clearTimeout(response.timeout);
      response.reject(error);
    }
    pending.clear();
  };

  const writeRecord = (record: unknown): Promise<void> => {
    const line = `${JSON.stringify(record)}\n`;
    const write = writeQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (closed || failure) {
            reject(failure ?? new Error("RPC peer is closed"));
            return;
          }
          writesInFlight += 1;
          let finished = false;
          const finish = (error?: Error | null) => {
            if (finished) return;
            finished = true;
            writesInFlight -= 1;
            settleIfReady();
            if (error) reject(error);
            else resolve();
          };
          try {
            options.stdin.write(line, "utf8", finish);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }),
    );
    writeQueue = write.catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    return write;
  };

  const onStreamError = (error: Error) => fail(error);
  options.stdin.on("error", onStreamError);

  return {
    send(command) {
      if (failure) return Promise.reject(failure);
      if (closed) return Promise.reject(new Error("RPC peer is closed"));
      if (settled) return Promise.reject(new Error("RPC child is settled"));
      if (pending.size >= maxPendingCommands) {
        return Promise.reject(new Error("RPC command queue is full"));
      }

      const id = randomUUID();
      return new Promise<RpcResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          const response = pending.get(id);
          if (!response) return;
          pending.delete(id);
          response.reject(new Error(`RPC ${command.type} command timed out`));
          settleIfReady();
        }, options.commandTimeoutMs);
        pending.set(id, { command: command.type, resolve, reject, timeout });
        void writeRecord({ ...command, id }).catch((error: unknown) => {
          const response = pending.get(id);
          if (!response) return;
          pending.delete(id);
          clearTimeout(response.timeout);
          response.reject(error instanceof Error ? error : new Error(String(error)));
          settleIfReady();
        });
      });
    },
    acceptLine(record) {
      if (!isRecord(record)) return "event";
      const item = record;
      if (item.type === "agent_settled") {
        settled = true;
        settleIfReady();
        return "consumed";
      }
      if (item.type !== "response" || typeof item.id !== "string") return "event";
      const response = pending.get(item.id);
      if (!response) return "consumed";
      pending.delete(item.id);
      clearTimeout(response.timeout);
      if (typeof item.command !== "string" || item.command !== response.command) {
        response.reject(new Error("RPC response command did not match request"));
      } else if (typeof item.success !== "boolean") {
        response.reject(new Error("RPC response was malformed"));
      } else {
        const parsedResponse: RpcResponse = {
          id: item.id,
          command: response.command,
          success: item.success,
          ...(item.data === undefined ? {} : { data: item.data }),
          ...(typeof item.error === "string" ? { error: item.error } : {}),
        };
        if (parsedResponse.success) response.resolve(parsedResponse);
        else response.reject(new RpcCommandError(parsedResponse));
      }
      settleIfReady();
      return "consumed";
    },
    waitForSettled(signal) {
      if (!signal) return settledPromise;
      if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Wait aborted"));
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("Wait aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        settledPromise
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", onAbort));
      });
    },
    fail,
    close() {
      if (closed) return;
      closed = true;
      options.stdin.off("error", onStreamError);
      if (!settled || pending.size > 0) fail(new Error("RPC peer closed before settlement"));
    },
  };
}
