import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const piPackagePath = path.join(
  repositoryRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
const piPackageManifestValue: unknown = JSON.parse(
  fs.readFileSync(path.join(piPackagePath, "package.json"), "utf8"),
);

if (!isJsonRecord(piPackageManifestValue) || piPackageManifestValue.version !== "1.5.0") {
  throw new Error("The RPC integration tests require the repo-pinned Pi 1.5.0 package.");
}

export const pinnedPiCliPath = path.join(piPackagePath, "dist", "cli.js");

export function createTemporaryProject(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonLines(filePath: string): JsonRecord[] {
  if (!fs.existsSync(filePath)) return [];

  const contents = fs.readFileSync(filePath, "utf8");
  const lines = contents.split("\n");
  if (!contents.endsWith("\n")) lines.pop();

  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!isJsonRecord(value)) throw new Error(`Expected a JSON object in ${filePath}.`);
      return value;
    });
}

export async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, remainingMs)));
  }
}

export function waitForFile(filePath: string, timeoutMs = 15_000): Promise<void> {
  return waitForCondition(() => fs.existsSync(filePath), `file ${filePath}`, timeoutMs);
}

type RpcWaiter = {
  predicate: (record: JsonRecord) => boolean;
  resolve: (record: JsonRecord) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type StartPiRpcOptions = {
  projectDirectory: string;
  agentDirectory: string;
  model: string;
  extensions: string[];
  environment?: NodeJS.ProcessEnv;
};

export function startPiRpc(options: StartPiRpcOptions) {
  const child = spawn(
    process.execPath,
    [
      pinnedPiCliPath,
      "--mode",
      "rpc",
      "--no-session",
      "--model",
      options.model,
      ...options.extensions.flatMap((extension) => ["--extension", extension]),
    ],
    {
      cwd: options.projectDirectory,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: options.agentDirectory,
        PI_CODING_AGENT_SESSION_DIR: path.join(options.agentDirectory, "sessions"),
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        TMPDIR: options.projectDirectory,
        ...options.environment,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const records: JsonRecord[] = [];
  const waiters = new Set<RpcWaiter>();
  let stdoutBuffer = "";
  let stderr = "";
  let processError: Error | undefined;
  let closed = false;

  const diagnostics = (): string => {
    const recentRecords = records.slice(-10).map((record) => {
      const message = isJsonRecord(record.message) ? record.message : undefined;
      const content = Array.isArray(message?.content)
        ? message.content.flatMap((part) =>
            isJsonRecord(part) && part.type === "text" && typeof part.text === "string"
              ? [part.text.slice(0, 120)]
              : [],
          )
        : [];
      return {
        type: record.type,
        command: record.command,
        id: record.id,
        role: message?.role,
        customType: message?.customType,
        content,
      };
    });
    return `stderr:\n${stderr || "(empty)"}\nrecent RPC records:\n${JSON.stringify(recentRecords)}`;
  };

  const rejectWaiters = (error: Error): void => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    waiters.clear();
  };

  const acceptRecord = (record: JsonRecord): void => {
    records.push(record);
    for (const waiter of waiters) {
      try {
        if (!waiter.predicate(record)) continue;
        waiters.delete(waiter);
        clearTimeout(waiter.timeout);
        waiter.resolve(record);
      } catch (error) {
        waiters.delete(waiter);
        clearTimeout(waiter.timeout);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  const acceptLine = (line: string): void => {
    if (line.trim().length === 0) return;

    try {
      const value: unknown = JSON.parse(line);
      if (!isJsonRecord(value)) throw new Error("RPC output was not a JSON object.");
      acceptRecord(value);
    } catch (error) {
      processError = new Error(`Could not parse Pi RPC output: ${String(error)}\n${diagnostics()}`);
      rejectWaiters(processError);
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    while (stdoutBuffer.includes("\n")) {
      const boundary = stdoutBuffer.indexOf("\n");
      acceptLine(stdoutBuffer.slice(0, boundary));
      stdoutBuffer = stdoutBuffer.slice(boundary + 1);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("error", (error) => {
    processError = new Error(
      `Could not start the Pi RPC process: ${error.message}\n${diagnostics()}`,
    );
    rejectWaiters(processError);
  });
  child.once("close", (code, signal) => {
    if (stdoutBuffer.trim().length > 0) acceptLine(stdoutBuffer);
    stdoutBuffer = "";
    closed = true;
    rejectWaiters(
      processError ??
        new Error(
          `Pi RPC process exited before the expected event (code ${code}, signal ${signal}).\n${diagnostics()}`,
        ),
    );
  });

  function waitFor(
    predicate: (record: JsonRecord) => boolean,
    timeoutMs = 15_000,
  ): Promise<JsonRecord> {
    const existing = records.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (processError) return Promise.reject(processError);
    if (closed) return Promise.reject(new Error(`Pi RPC process has closed.\n${diagnostics()}`));

    return new Promise((resolve, reject) => {
      let waiter: RpcWaiter;
      const timeout = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Timed out waiting for an RPC event.\n${diagnostics()}`));
      }, timeoutMs);
      waiter = { predicate, resolve, reject, timeout };
      waiters.add(waiter);
    });
  }

  function signalProcess(signal: NodeJS.Signals): void {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The process group may already have exited.
      }
    }
    child.kill(signal);
  }

  async function close(): Promise<void> {
    if (closed) return;

    const closeEvent = once(child, "close").then(() => "closed" as const);
    signalProcess("SIGTERM");
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), 2_000);
    });
    const outcome = await Promise.race([closeEvent, timedOut]);
    if (timeout) clearTimeout(timeout);
    if (outcome === "timeout") {
      signalProcess("SIGKILL");
      await closeEvent;
    }
  }

  return {
    records,
    stderr: () => stderr,
    send(command: JsonRecord): void {
      if (!child.stdin.writable) throw new Error("Pi RPC input is closed.");
      child.stdin.write(`${JSON.stringify(command)}\n`);
    },
    waitFor,
    close,
  };
}
