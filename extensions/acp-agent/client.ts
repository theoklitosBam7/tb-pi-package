import { spawn } from "node:child_process";

export interface AcpAgentConfig {
  command: string;
  args: string[];
}

const MAX_TASK = 100_000;
const MAX_FRAME = 1024 * 1024;
const MAX_OUTPUT = 256 * 1024;
const TIMEOUT_MS = 120_000;

/** Run one isolated ACP v1 session over JSON-RPC stdio. */
export async function runAcpTask(
  config: AcpAgentConfig,
  cwd: string,
  task: string,
  signal?: AbortSignal,
): Promise<string> {
  if (task.length > MAX_TASK) throw new Error("ACP task too long");
  if (signal?.aborted) throw new Error("ACP task cancelled");
  if (!config.command || !Array.isArray(config.args) || !config.args.every(a => typeof a === "string"))
    throw new Error("Invalid ACP executable configuration");

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(config.command, config.args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    let settled = false;
    let buffer = "";
    let output = "";
    let nextId = 0;
    let stage = 0;
    const timeout = setTimeout(() => fail(new Error("ACP task timed out")), TIMEOUT_MS);
    const abort = () => fail(new Error("ACP task cancelled"));
    signal?.addEventListener("abort", abort, { once: true });

    function cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
    function fail(error: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill("SIGKILL");
      reject(error);
    }
    function succeed() {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdin.end();
      child.kill();
      resolve(output);
    }
    function send(method: string, params: unknown) {
      if (settled) return;
      const frame = JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }) + "\n";
      if (!child.stdin.write(frame)) child.stdin.once("drain", () => {});
    }
    child.on("error", (error) => fail(error));
    child.on("close", (code) => {
      if (!settled) fail(new Error(`ACP process exited before completion (${code})`));
    });
    // Do not expose stderr: it may include credentials and private file contents.
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_FRAME) {
        fail(new Error("ACP frame too large"));
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1 && !settled) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let frame: any;
        try { frame = JSON.parse(line); } catch { fail(new Error("Invalid ACP JSON")); return; }
        if (frame.method === "session/update") {
          const update = frame.params?.update;
          if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
            const text = update.content.text;
            if (typeof text !== "string") { fail(new Error("Invalid ACP text")); return; }
            output += text;
            if (Buffer.byteLength(output) > MAX_OUTPUT) fail(new Error("ACP output too large"));
          }
          continue;
        }
        // Never authorize remote permission or file-system requests.
        if (typeof frame.method === "string" && frame.id !== undefined) {
          child.stdin.write(JSON.stringify({
            jsonrpc: "2.0", id: frame.id,
            error: { code: -32601, message: "Client operation not permitted" },
          }) + "\n");
          continue;
        }
        if (frame.id !== nextId) continue;
        if (frame.error) { fail(new Error("ACP agent returned an error")); return; }
        if (stage === 0) {
          if (frame.result?.protocolVersion !== 1) { fail(new Error("Unsupported ACP protocol version")); return; }
          stage = 1;
          send("session/new", { cwd, mcpServers: [] });
        } else if (stage === 1) {
          const sessionId = frame.result?.sessionId;
          if (typeof sessionId !== "string" || !sessionId) { fail(new Error("Invalid ACP session")); return; }
          stage = 2;
          send("session/prompt", { sessionId, prompt: [{ type: "text", text: task }] });
        } else if (stage === 2) {
          succeed();
        }
      }
    });
    send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
  });
}
