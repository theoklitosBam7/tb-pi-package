import { PassThrough, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { createRpcPeer } from "./rpc-peer.js";

describe("RPC child peer", () => {
  it("correlates command responses while leaving session events to the runner", async () => {
    const stdin = new PassThrough();
    const peer = createRpcPeer({ stdin, commandTimeoutMs: 1000 });
    const writes: string[] = [];
    stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));

    const response = peer.send({ type: "steer", message: "Check the tests" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const command = JSON.parse(writes[0]) as { id: string; type: string };

    expect(peer.acceptLine({ type: "message_update", assistantMessageEvent: {} })).toBe("event");
    expect(
      peer.acceptLine({
        type: "response",
        id: command.id,
        command: "steer",
        success: true,
        data: { disposition: "queued" },
      }),
    ).toBe("consumed");
    await expect(response).resolves.toMatchObject({
      success: true,
      data: { disposition: "queued" },
    });
    peer.close();
  });

  it("rejects commands after settlement and resolves only after pending responses finish", async () => {
    const stdin = new PassThrough();
    const peer = createRpcPeer({ stdin, commandTimeoutMs: 1000 });
    const writes: string[] = [];
    stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));

    const pending = peer.send({ type: "follow_up", message: "One more check" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const command = JSON.parse(writes[0]) as { id: string };
    peer.acceptLine({ type: "agent_settled" });
    let settled = false;
    void peer.waitForSettled().then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    peer.acceptLine({
      type: "response",
      id: command.id,
      command: "follow_up",
      success: true,
      data: { disposition: "queued" },
    });
    await pending;
    await peer.waitForSettled();
    await expect(peer.send({ type: "abort" })).rejects.toThrow("settled");
    peer.close();
  });

  it("waits for an in-flight stdin write before reporting settlement", async () => {
    let finishWrite: (() => void) | undefined;
    let requestId = "";
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        requestId = (JSON.parse(chunk.toString("utf8")) as { id: string }).id;
        finishWrite = () => callback();
      },
    });
    const peer = createRpcPeer({ stdin, commandTimeoutMs: 1000 });
    const response = peer.send({ type: "prompt", message: "Start" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const request = peer.acceptLine({
      type: "response",
      id: requestId,
      command: "prompt",
      success: true,
    });
    expect(request).toBe("consumed");
    peer.acceptLine({ type: "agent_settled" });
    let settled = false;
    void peer.waitForSettled().then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    finishWrite?.();
    await response.catch(() => {});
    await peer.waitForSettled();
    peer.close();
  });

  it("rejects a response with malformed fields", async () => {
    const stdin = new PassThrough();
    const peer = createRpcPeer({ stdin, commandTimeoutMs: 1000 });
    const writes: string[] = [];
    stdin.on("data", (chunk: Buffer) => writes.push(chunk.toString("utf8")));

    const response = peer.send({ type: "steer", message: "Check the tests" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const command = JSON.parse(writes[0]) as { id: string };

    expect(
      peer.acceptLine({ type: "response", id: command.id, command: "steer", success: "yes" }),
    ).toBe("consumed");
    await expect(response).rejects.toThrow("RPC response was malformed");
    peer.close();
  });

  it("rejects pending commands when child stdin fails", async () => {
    const stdin = new PassThrough();
    const peer = createRpcPeer({ stdin, commandTimeoutMs: 1000 });
    const response = peer.send({ type: "prompt", message: "Start" });
    stdin.destroy(new Error("stdin closed"));

    await expect(response).rejects.toThrow("stdin closed");
    await expect(peer.waitForSettled()).rejects.toThrow("stdin closed");
    peer.close();
  });

  it("rejects pending work when the child closes before settlement", async () => {
    const stdin = new PassThrough();
    const peer = createRpcPeer({ stdin, commandTimeoutMs: 1000 });
    const response = peer.send({ type: "steer", message: "Keep going" });
    peer.close();

    await expect(response).rejects.toThrow("RPC peer closed before settlement");
    await expect(peer.waitForSettled()).rejects.toThrow("RPC peer closed before settlement");
  });

  it("rejects a command that does not receive a response before its deadline", async () => {
    const stdin = new PassThrough();
    const peer = createRpcPeer({ stdin, commandTimeoutMs: 10 });

    await expect(peer.send({ type: "follow_up", message: "Continue" })).rejects.toThrow(
      "RPC follow_up command timed out",
    );
    peer.close();
  });

  it("[process integration] sends a prompt over real child stdin and waits for settlement", async () => {
    const script = [
      "const readline = require('node:readline')",
      "readline.createInterface({ input: process.stdin }).on('line', line => {",
      "  const command = JSON.parse(line)",
      "  process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: command.type, success: true, data: { disposition: 'started' } }) + '\\n')",
      "  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')",
      "})",
    ].join("\n");
    const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "ignore"] });
    if (!child.stdin || !child.stdout) throw new Error("Child pipes were not created");
    const peer = createRpcPeer({ stdin: child.stdin, commandTimeoutMs: 2000 });
    const lines = createInterface({ input: child.stdout });
    const settled = peer.waitForSettled();
    lines.on("line", (line) => {
      const record: unknown = JSON.parse(line);
      peer.acceptLine(record);
    });

    await expect(
      peer.send({ type: "prompt", message: "Run the local check" }),
    ).resolves.toMatchObject({
      command: "prompt",
      success: true,
      data: { disposition: "started" },
    });
    await settled;
    peer.close();
    child.kill();
  });
});
