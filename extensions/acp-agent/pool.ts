import { spawn } from "node:child_process";
import type { AcpAgentConfig } from "./client.js";

type Waiter = { resolve: (value: any) => void; reject: (error: Error) => void };
type Session = {
  child: ReturnType<typeof spawn>; id: string; seq: number; buffer: string;
  pending: Map<number, Waiter>; busy: boolean; closed: boolean;
  timer?: ReturnType<typeof setTimeout>; output: string; activity?: () => void;
  stop: (error: Error) => void; send: (method: string, params: unknown) => Promise<any>;
};
const LIMIT = 3_600_000;
function limit(value: number | undefined, fallback: number) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > LIMIT) throw new Error("Invalid ACP timeout");
  return n;
}
export class AcpSessionPool {
  private sessions = new Map<string, Session>();
  private opening = new Set<string>();
  private idle: number;
  constructor(opts: { idleTimeoutMs?: number } = {}) { this.idle = limit(opts.idleTimeoutMs, 60_000); }
  close() {
    for (const s of this.sessions.values()) s.stop(new Error("ACP pool closed"));
    this.sessions.clear();
  }
  async run(name: string, config: AcpAgentConfig, cwd: string, task: string, signal?: AbortSignal): Promise<string> {
    if (task.length > 100_000) throw new Error("ACP task too long");
    if (signal?.aborted) throw new Error("ACP task cancelled");
    const total = limit(config.timeoutMs, 600_000);
    const startup = limit(config.startupTimeoutMs, 30_000);
    const quiet = limit(config.inactivityTimeoutMs, 120_000);
    const key = JSON.stringify([name, cwd, config.command, config.args, total, startup, quiet]);
    let s = this.sessions.get(key);
    if (s?.busy || this.opening.has(key)) throw new Error("ACP agent session busy");
    if (!s && this.sessions.size + this.opening.size >= 2) throw new Error("ACP session limit reached");
    this.opening.add(key);
    if (!s) { s = this.create(config, cwd); this.sessions.set(key, s); }
    const current = s;
    current.busy = true; clearTimeout(current.timer);
    this.opening.delete(key);
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const dead = new Promise<never>((_, reject) => {
        const stop = (why: string) => { const error = new Error(why); current.stop(error); reject(error); };
        totalTimer = setTimeout(() => stop("ACP task timed out"), total);
        quietTimer = setTimeout(() => stop("ACP inactivity timed out"), quiet);
        if (!current.id) startupTimer = setTimeout(() => stop("ACP startup timed out"), startup);
        onAbort = () => stop("ACP task cancelled");
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      current.activity = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => current.stop(new Error("ACP inactivity timed out")), quiet);
      };
      const work = (async () => {
        if (!current.id) {
          const init = await current.send("initialize", { protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
          if (init?.protocolVersion !== 1) throw new Error("Unsupported ACP protocol version");
          clearTimeout(startupTimer);
          const created = await current.send("session/new", { cwd, mcpServers: [] });
          if (typeof created?.sessionId !== "string" || !created.sessionId) throw new Error("Invalid ACP session");
          current.id = created.sessionId;
        }
        current.output = "";
        await current.send("session/prompt", { sessionId: current.id, prompt: [{ type: "text", text: task }] });
        return current.output;
      })();
      return await Promise.race([work, dead]);
    } catch (error) {
      current.stop(error instanceof Error ? error : new Error("ACP task failed"));
      throw error;
    } finally {
      clearTimeout(totalTimer); clearTimeout(startupTimer); clearTimeout(quietTimer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      current.activity = undefined;
      current.busy = false;
      if (current.closed) this.sessions.delete(key);
      else {
        current.timer = setTimeout(() => {
          current.stop(new Error("ACP idle timeout"));
          if (this.sessions.get(key) === current) this.sessions.delete(key);
        }, this.idle);
        current.timer.unref?.();
      }
    }
  }
  private create(config: AcpAgentConfig, cwd: string): Session {
    const child = spawn(config.command, config.args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const s: Session = {
      child, id: "", seq: 0, buffer: "", pending: new Map(), busy: false, closed: false, output: "",
      stop(error) {
        if (s.closed) return;
        s.closed = true;
        clearTimeout(s.timer);
        for (const p of s.pending.values()) p.reject(error);
        s.pending.clear();
        child.kill();
      },
      send(method, params) {
        if (s.closed) return Promise.reject(new Error("ACP session closed"));
        const id = ++s.seq;
        return new Promise((resolve, reject) => {
          s.pending.set(id, { resolve, reject });
          child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", error => {
            if (error) s.stop(new Error("ACP transport failed"));
          });
        });
      },
    };
    child.on("error", () => s.stop(new Error("ACP process failed")));
    child.on("close", () => s.stop(new Error("ACP process closed")));
    child.stderr?.on("data", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
      if (s.closed) return;
      s.buffer += chunk.toString("utf8");
      if (Buffer.byteLength(s.buffer) > 1024 * 1024) return s.stop(new Error("ACP frame too large"));
      let i: number;
      while ((i = s.buffer.indexOf("\n")) >= 0 && !s.closed) {
        const line = s.buffer.slice(0, i); s.buffer = s.buffer.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line);
          if (frame?.jsonrpc !== "2.0") throw new Error("Invalid ACP message");
          s.activity?.();
          if (typeof frame.method === "string") {
            if (frame.id !== undefined) {
              child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id,
                error: { code: -32601, message: "Client operation not permitted" } }) + "\n");
            } else if (frame.method === "session/update" && frame.params?.sessionId === s.id) {
              const u = frame.params.update;
              if (u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
                if (typeof u.content.text !== "string") throw new Error("Invalid ACP text");
                s.output += u.content.text;
                if (Buffer.byteLength(s.output) > 256 * 1024) throw new Error("ACP output too large");
              }
            }
          } else {
            const p = s.pending.get(frame.id);
            if (p) { s.pending.delete(frame.id);
              if (frame.error) p.reject(new Error("ACP agent returned an error"));
              else p.resolve(frame.result);
            }
          }
        } catch (e) { s.stop(e instanceof Error ? e : new Error("Invalid ACP JSON")); }
      }
    });
    return s;
  }
}
