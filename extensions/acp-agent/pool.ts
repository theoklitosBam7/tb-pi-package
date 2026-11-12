import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const RequestIdSchema = Type.Union([Type.String(), Type.Integer()]);
const MethodMessageSchema = Type.Object({
  jsonrpc: Type.Literal("2.0"),
  method: Type.String({ minLength: 1 }),
  id: Type.Optional(RequestIdSchema),
  params: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Array(Type.Unknown())]),
  ),
  result: Type.Optional(Type.Never()),
  error: Type.Optional(Type.Never()),
});
const ResultMessageSchema = Type.Object({
  jsonrpc: Type.Literal("2.0"),
  id: RequestIdSchema,
  result: Type.Unknown(),
  error: Type.Optional(Type.Never()),
  method: Type.Optional(Type.Never()),
});
const ErrorMessageSchema = Type.Object({
  jsonrpc: Type.Literal("2.0"),
  id: RequestIdSchema,
  error: Type.Object({
    code: Type.Integer(),
    message: Type.String(),
    data: Type.Optional(Type.Unknown()),
  }),
  result: Type.Optional(Type.Never()),
  method: Type.Optional(Type.Never()),
});
const InitializeResultSchema = Type.Object({ protocolVersion: Type.Literal(1) });
const NewSessionResultSchema = Type.Object({ sessionId: Type.String({ minLength: 1 }) });
const SessionUpdateSchema = Type.Object({
  sessionId: Type.String(),
  update: Type.Object({
    sessionUpdate: Type.String(),
    content: Type.Optional(Type.Unknown()),
  }),
});
const ContentHeaderSchema = Type.Object({ type: Type.String() });
const TextContentSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });

function parseMessage(line: string) {
  const value: unknown = JSON.parse(line);
  if (Value.Check(MethodMessageSchema, value)) return { kind: "method" as const, message: value };
  if (Value.Check(ResultMessageSchema, value)) return { kind: "result" as const, message: value };
  if (Value.Check(ErrorMessageSchema, value)) return { kind: "error" as const, message: value };
  throw new Error("Invalid ACP message");
}
export const AcpTimeoutSchema = Type.Integer({ minimum: 1, maximum: 3_600_000 });
export const AcpAgentConfigSchema = Type.Object({
  command: Type.String({ minLength: 1 }),
  args: Type.Array(Type.String()),
  timeoutMs: Type.Optional(AcpTimeoutSchema),
  startupTimeoutMs: Type.Optional(AcpTimeoutSchema),
  inactivityTimeoutMs: Type.Optional(AcpTimeoutSchema),
});
export type AcpAgentConfig = Static<typeof AcpAgentConfigSchema>;

type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Session = {
  child: ReturnType<typeof spawn>;
  id: string;
  seq: number;
  buffer: string;
  pending: Map<number, Waiter>;
  busy: boolean;
  closed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  output: string;
  activity?: () => void;
  stop: (error: Error) => void;
  send: (method: string, params: unknown) => Promise<unknown>;
};
function limit(value: number | undefined, fallback: number) {
  const timeout = value ?? fallback;
  if (!Value.Check(AcpTimeoutSchema, timeout)) throw new Error("Invalid ACP timeout");
  return timeout;
}
export class AcpSessionPool {
  private sessions = new Map<string, Session>();
  private opening = new Set<string>();
  private evictClosed() {
    for (const [key, s] of this.sessions) if (s.closed) this.sessions.delete(key);
  }
  private idle: number;
  constructor(opts: { idleTimeoutMs?: number } = {}) {
    this.idle = limit(opts.idleTimeoutMs, 60_000);
  }
  close() {
    for (const s of this.sessions.values()) s.stop(new Error("ACP pool closed"));
    this.sessions.clear();
  }
  async run(
    name: string,
    config: AcpAgentConfig,
    cwd: string,
    task: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (task.length > 100_000) throw new Error("ACP task too long");
    if (
      !config.command ||
      !Array.isArray(config.args) ||
      !config.args.every((a) => typeof a === "string")
    )
      throw new Error("Invalid ACP executable configuration");
    if (signal?.aborted) throw new Error("ACP task cancelled");
    const total = limit(config.timeoutMs, 600_000);
    const startup = limit(config.startupTimeoutMs, 30_000);
    const quiet = limit(config.inactivityTimeoutMs, 120_000);
    const key = JSON.stringify([name, cwd, config.command, config.args, total, startup, quiet]);
    let s = this.sessions.get(key);
    if (s?.closed) {
      this.sessions.delete(key);
      s = undefined;
    }
    if (s?.busy || this.opening.has(key)) throw new Error("ACP agent session busy");
    this.evictClosed();
    if (!s && this.sessions.size + this.opening.size >= 2) {
      const idle = [...this.sessions.entries()].find(([, item]) => !item.busy);
      if (!idle) throw new Error("ACP session limit reached");
      idle[1].stop(new Error("ACP idle session evicted"));
      this.sessions.delete(idle[0]);
    }
    this.opening.add(key);
    if (!s) {
      s = this.create(config, cwd);
      this.sessions.set(key, s);
    }
    const current = s;
    current.busy = true;
    clearTimeout(current.timer);
    this.opening.delete(key);
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const dead = new Promise<never>((_, reject) => {
        const stop = (why: string) => {
          const error = new Error(why);
          current.stop(error);
          reject(error);
        };
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
          const init = await current.send("initialize", {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
          });
          if (!Value.Check(InitializeResultSchema, init))
            throw new Error("Unsupported ACP protocol version");
          clearTimeout(startupTimer);
          const created = await current.send("session/new", { cwd, mcpServers: [] });
          if (!Value.Check(NewSessionResultSchema, created)) throw new Error("Invalid ACP session");
          current.id = created.sessionId;
        }
        current.output = "";
        await current.send("session/prompt", {
          sessionId: current.id,
          prompt: [{ type: "text", text: task }],
        });
        return current.output;
      })();
      return await Promise.race([work, dead]);
    } catch (error) {
      current.stop(error instanceof Error ? error : new Error("ACP task failed"));
      throw error;
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(startupTimer);
      clearTimeout(quietTimer);
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
    const child = spawn(config.command, config.args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const decoder = new StringDecoder("utf8");
    const s: Session = {
      child,
      id: "",
      seq: 0,
      buffer: "",
      pending: new Map(),
      busy: false,
      closed: false,
      output: "",
      stop(error) {
        if (s.closed) return;
        s.closed = true;
        clearTimeout(s.timer);
        for (const p of s.pending.values()) p.reject(error);
        s.pending.clear();
        child.kill("SIGKILL");
      },
      send(method, params) {
        if (s.closed) return Promise.reject(new Error("ACP session closed"));
        const id = ++s.seq;
        return new Promise((resolve, reject) => {
          s.pending.set(id, { resolve, reject });
          child.stdin?.write(
            JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
            (error) => {
              if (error) s.stop(new Error("ACP transport failed"));
            },
          );
        });
      },
    };
    child.on("error", () => s.stop(new Error("ACP process failed")));
    child.stdin?.on("error", () => s.stop(new Error("ACP transport failed")));
    child.on("close", () => s.stop(new Error("ACP process closed")));
    child.stderr?.on("data", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
      if (s.closed) return;
      s.buffer += decoder.write(chunk);
      let i: number;
      while ((i = s.buffer.indexOf("\n")) >= 0 && !s.closed) {
        const line = s.buffer.slice(0, i);
        s.buffer = s.buffer.slice(i + 1);
        if (Buffer.byteLength(line) > 1024 * 1024) return s.stop(new Error("ACP frame too large"));
        if (!line.trim()) continue;
        try {
          const frame = parseMessage(line);
          s.activity?.();
          if (frame.kind === "method") {
            const message = frame.message;
            if (message.id !== undefined) {
              child.stdin?.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32601, message: "Client operation not permitted" },
                }) + "\n",
              );
            } else if (message.method === "session/update") {
              if (!Value.Check(SessionUpdateSchema, message.params))
                throw new Error("Invalid ACP session update");
              const { sessionId, update } = message.params;
              if (
                sessionId === s.id &&
                update.sessionUpdate === "agent_message_chunk" &&
                Value.Check(ContentHeaderSchema, update.content) &&
                update.content.type === "text"
              ) {
                if (!Value.Check(TextContentSchema, update.content))
                  throw new Error("Invalid ACP text");
                s.output += update.content.text;
                if (Buffer.byteLength(s.output) > 256 * 1024)
                  throw new Error("ACP output too large");
              }
            }
          } else {
            const id = frame.message.id;
            const waiter = typeof id === "number" ? s.pending.get(id) : undefined;
            if (waiter && typeof id === "number") {
              s.pending.delete(id);
              if (frame.kind === "error") waiter.reject(new Error("ACP agent returned an error"));
              else waiter.resolve(frame.message.result);
            }
          }
        } catch (e) {
          s.stop(e instanceof Error ? e : new Error("Invalid ACP JSON"));
        }
      }
      if (!s.closed && Buffer.byteLength(s.buffer) > 1024 * 1024)
        s.stop(new Error("ACP frame too large"));
    });
    return s;
  }
}
