import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { createRpcPeer } from "./rpc-peer.js";
import { createRunManager, type RunOwner, type RunSnapshot } from "./run-manager.js";

const owner: RunOwner = { sessionId: "rpc-failure-session", generation: 1 };
const children: ChildProcess[] = [];

function launchChild(source: string): { child: ChildProcess; ready: Promise<void> } {
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  children.push(child);
  if (!child.stdin || !child.stdout) throw new Error("Child pipes were not created");
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise<void>((resolve, reject) => {
    lines.on("line", (line) => {
      if (line === "READY") resolve();
    });
    child.once("error", reject);
  });
  return { child, ready };
}

function createRun(child: ChildProcess) {
  if (!child.stdin || !child.stdout) throw new Error("Child pipes were not created");
  const peer = createRpcPeer({ stdin: child.stdin, commandTimeoutMs: 2_000 });
  const lines = createInterface({ input: child.stdout });
  const manager = createRunManager(owner);
  const scheduled = manager.scheduleBatch({
    ...owner,
    jobs: [
      {
        agent: "fixture",
        task: "Exercise child RPC failure handling",
        async execute(context) {
          context.registerControl(async (message) => {
            await peer.send({ type: message.mode, message: message.content });
          });
          child.once("exit", (code, signal) => {
            peer.fail(
              new Error(`Child exited before RPC settlement (${code ?? signal ?? "unknown"})`),
            );
          });
          lines.on("line", (line) => {
            if (line === "READY") return;
            let record: unknown;
            try {
              record = JSON.parse(line);
            } catch {
              peer.fail(new Error("Malformed RPC record from child"));
              return;
            }
            peer.acceptLine(record);
          });
          await peer.send({ type: "prompt", message: "Start fixture" });
          await peer.waitForSettled(context.signal);
          return { status: "completed" };
        },
      },
    ],
  });
  return { manager, scheduled, peer };
}

async function completedSnapshot(
  manager: ReturnType<typeof createRunManager>,
  runId: string,
): Promise<RunSnapshot> {
  let snapshot: RunSnapshot | undefined;
  await expect(
    Promise.race([
      (async () => {
        while (
          !snapshot ||
          ["queued", "starting", "running", "stopping"].includes(snapshot.state.kind)
        ) {
          snapshot = await manager.getRun({ ...owner, runId });
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Run did not settle")), 3_000);
        timer.unref();
      }),
    ]),
  ).resolves.toBeUndefined();
  if (!snapshot) throw new Error("Run snapshot was not available");
  return snapshot;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

describe("real child RPC failure integration", () => {
  it("fails a pending prompt on a malformed RPC record without hanging", async () => {
    const { child, ready } = launchChild(
      [
        'process.stdin.on("data", () => {',
        '  process.stdout.write("{not-json}\\n");',
        '  process.stdout.write("READY\\n");',
        "});",
      ].join("\n"),
    );
    const { manager, scheduled } = createRun(child);
    await expect(ready).resolves.toBeUndefined();
    const result = await scheduled;
    if (result.kind !== "scheduled") throw new Error("Expected a scheduled run");
    const run = await completedSnapshot(manager, result.runs[0]!.id);
    expect(run.state).toMatchObject({ kind: "failed", error: "Malformed RPC record from child" });
  });

  it("marks an accepted command undelivered when the real child closes stdin", async () => {
    const { child, ready } = launchChild(
      [
        'let input = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", chunk => {',
        "  input += chunk;",
        '  while (input.includes("\\n")) {',
        '    const boundary = input.indexOf("\\n");',
        "    const command = JSON.parse(input.slice(0, boundary));",
        "    input = input.slice(boundary + 1);",
        '    if (command.type === "prompt") {',
        '      process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } }) + "\\n");',
        '      process.stdout.write("READY\\n");',
        '    } else if (command.type === "steer") {',
        "      process.stdin.destroy();",
        "    }",
        "  }",
        "});",
      ].join("\n"),
    );
    const { manager, scheduled } = createRun(child);
    const result = await scheduled;
    if (result.kind !== "scheduled") throw new Error("Expected a scheduled run");
    await expect(ready).resolves.toBeUndefined();
    const beforeMessage = await manager.getRun({ ...owner, runId: result.runs[0]!.id });
    expect(beforeMessage?.state.kind, JSON.stringify(beforeMessage)).toBe("running");
    const accepted = await manager.sendMessage({
      ...owner,
      runId: result.runs[0]!.id,
      content: "This command cannot reach the child",
      mode: "steer",
    });
    expect(accepted.kind).toBe("accepted");
    const run = await completedSnapshot(manager, result.runs[0]!.id);
    expect(run.messages).toMatchObject([{ outcome: "undelivered" }]);
    expect(run.state.kind).toBe("failed");
  });

  it("records an RPC-accepted message when the child accepts it and then exits", async () => {
    const { child, ready } = launchChild(
      [
        'let input = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", chunk => {',
        "  input += chunk;",
        '  while (input.includes("\\n")) {',
        '    const boundary = input.indexOf("\\n");',
        "    const command = JSON.parse(input.slice(0, boundary));",
        "    input = input.slice(boundary + 1);",
        '    if (command.type === "prompt") {',
        '      process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true, data: { disposition: "started" } }) + "\\n");',
        '      process.stdout.write("READY\\n");',
        '    } else if (command.type === "steer") {',
        '      process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "steer", success: true, data: { disposition: "queued" } }) + "\\n");',
        '      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");',
        "      process.exit(0);",
        "    }",
        "  }",
        "});",
      ].join("\n"),
    );
    const { manager, scheduled } = createRun(child);
    const result = await scheduled;
    if (result.kind !== "scheduled") throw new Error("Expected a scheduled run");
    await expect(ready).resolves.toBeUndefined();
    const beforeMessage = await manager.getRun({ ...owner, runId: result.runs[0]!.id });
    expect(beforeMessage?.state.kind, JSON.stringify(beforeMessage)).toBe("running");
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });
    const accepted = await manager.sendMessage({
      ...owner,
      runId: result.runs[0]!.id,
      content: "Accept before exit",
      mode: "steer",
    });
    expect(accepted.kind).toBe("accepted");
    const run = await completedSnapshot(manager, result.runs[0]!.id);
    expect(run.messages).toMatchObject([{ outcome: "accepted-by-child" }]);
    expect(run.state.kind).toBe("completed");
    await expect(exited).resolves.toBe(0);
    expect(child.exitCode).toBe(0);
  });
});
