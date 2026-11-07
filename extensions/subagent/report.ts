import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isRecord } from "./is-record.js";

const MAX_REPORT_BYTES = 8 * 1024;
const MAX_FRAME_BYTES = MAX_REPORT_BYTES + 1024;
const MAX_PENDING_REPORTS = 16;
const MAX_REMEMBERED_REPORTS = 256;
const DEFAULT_ACK_TIMEOUT_MS = 5_000;
const SOCKET_ENV = "SUBAGENT_REPORT_SOCKET";
const TOKEN_ENV = "SUBAGENT_REPORT_TOKEN";
const RUN_ID_ENV = "SUBAGENT_REPORT_RUN_ID";

export type ChildReport = { runId: string; reportId: string; message: string };
export type ReportDecision = { accepted: true } | { accepted: false; reason: string };
export type ReportServer = {
  socketPath: string;
  token: string;
  environment: Record<string, string>;
  close(): Promise<void>;
};

function sendJson(socket: Socket, response: ReportDecision): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

export async function createReportServer(options: {
  runId: string;
  onReport(report: ChildReport): Promise<ReportDecision> | ReportDecision;
  maxReportBytes?: number;
  maxPendingReports?: number;
  ackTimeoutMs?: number;
  onError?(error: Error): void;
}): Promise<ReportServer> {
  const maxReportBytes = options.maxReportBytes ?? MAX_REPORT_BYTES;
  const maxPendingReports = options.maxPendingReports ?? MAX_PENDING_REPORTS;
  const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rpt-"));
  try {
    await fs.chmod(directory, 0o700);
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  const socketPath = path.join(directory, "r.sock");
  const token = randomBytes(32).toString("hex");
  const decisions = new Map<string, Promise<ReportDecision>>();
  const sockets = new Set<Socket>();
  let activeReports = 0;
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;

  const reportError = (error: Error): void => {
    try {
      options.onError?.(error);
    } catch {
      // Error reporting must not create another unhandled transport error.
    }
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", reportError);
    socket.setTimeout(ackTimeoutMs, () => socket.destroy());
    let frame = Buffer.alloc(0);
    let completed = false;
    socket.on("data", (chunk) => {
      if (completed) return;
      frame = Buffer.concat([frame, chunk]);
      if (frame.byteLength > MAX_FRAME_BYTES) {
        completed = true;
        sendJson(socket, { accepted: false, reason: "Report exceeds the size limit" });
        return;
      }
      const newline = frame.indexOf(0x0a);
      if (newline < 0) return;
      completed = true;
      const line = frame.subarray(0, newline);
      void handleFrame(line, socket).catch((error: unknown) => {
        socket.destroy();
        reportError(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    closed = true;
    for (const socket of sockets) socket.destroy();
    shutdownPromise = (async () => {
      try {
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    })();
    return shutdownPromise;
  };

  server.on("error", (error) => {
    reportError(error);
    void shutdown().catch((shutdownError: unknown) => {
      reportError(
        shutdownError instanceof Error ? shutdownError : new Error(String(shutdownError)),
      );
    });
  });

  const handleFrame = async (line: Buffer, socket: Socket): Promise<void> => {
    let value: unknown;
    try {
      value = JSON.parse(line.toString("utf8")) as unknown;
    } catch {
      sendJson(socket, { accepted: false, reason: "Malformed report" });
      return;
    }
    if (!isRecord(value)) {
      sendJson(socket, { accepted: false, reason: "Malformed report" });
      return;
    }
    const receivedToken = value.token;
    const receivedTokenBytes =
      typeof receivedToken === "string" ? Buffer.from(receivedToken) : Buffer.alloc(0);
    const expectedTokenBytes = Buffer.from(token);
    const tokenMatches =
      receivedTokenBytes.byteLength === expectedTokenBytes.byteLength &&
      timingSafeEqual(receivedTokenBytes, expectedTokenBytes);
    if (!tokenMatches || value.runId !== options.runId) {
      sendJson(socket, { accepted: false, reason: "Report authentication failed" });
      return;
    }
    if (
      typeof value.reportId !== "string" ||
      value.reportId.length === 0 ||
      value.reportId.length > 128 ||
      typeof value.message !== "string" ||
      Buffer.byteLength(value.message, "utf8") > maxReportBytes
    ) {
      sendJson(socket, { accepted: false, reason: "Report is invalid or exceeds the size limit" });
      return;
    }

    const reportId = value.reportId;
    const prior = decisions.get(reportId);
    if (prior) {
      sendJson(socket, await prior);
      return;
    }
    if (activeReports >= maxPendingReports) {
      sendJson(socket, { accepted: false, reason: "Report queue is full" });
      return;
    }

    activeReports += 1;
    const report = { runId: options.runId, reportId, message: value.message };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const decision = Promise.race([
      Promise.resolve().then(() => options.onReport(report)),
      new Promise<ReportDecision>((resolve) => {
        timeout = setTimeout(
          () => resolve({ accepted: false, reason: "Parent did not accept the report in time" }),
          ackTimeoutMs,
        );
      }),
    ]).catch((): ReportDecision => ({ accepted: false, reason: "Parent rejected the report" }));
    decisions.set(reportId, decision);
    if (decisions.size > MAX_REMEMBERED_REPORTS) {
      const oldest = decisions.keys().next().value;
      if (oldest !== undefined) decisions.delete(oldest);
    }
    const result = await decision;
    if (timeout) clearTimeout(timeout);
    activeReports -= 1;
    if (!closed && !socket.destroyed) sendJson(socket, result);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await fs.chmod(socketPath, 0o600);
  } catch (error) {
    try {
      await shutdown();
    } catch (shutdownError) {
      reportError(
        shutdownError instanceof Error ? shutdownError : new Error(String(shutdownError)),
      );
    }
    throw error;
  }

  return {
    socketPath,
    token,
    environment: {
      SUBAGENT_MANAGED_CHILD: "1",
      [SOCKET_ENV]: socketPath,
      [TOKEN_ENV]: token,
      [RUN_ID_ENV]: options.runId,
    },
    async close() {
      await shutdown();
    },
  };
}

async function submitReport(message: string): Promise<ReportDecision> {
  const socketPath = process.env[SOCKET_ENV];
  const token = process.env[TOKEN_ENV];
  const runId = process.env[RUN_ID_ENV];
  if (!socketPath || !token || !runId) throw new Error("Parent report channel is unavailable");
  if (Buffer.byteLength(message, "utf8") > MAX_REPORT_BYTES) {
    throw new Error(`Report exceeds the ${MAX_REPORT_BYTES}-byte limit`);
  }

  return new Promise<ReportDecision>((resolve, reject) => {
    const socket = connect(socketPath);
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Parent report channel timed out"));
    }, DEFAULT_ACK_TIMEOUT_MS);
    const finish = (error: Error | undefined, decision?: ReportDecision) => {
      clearTimeout(timer);
      if (error) reject(error);
      else if (decision) resolve(decision);
      else reject(new Error("Parent returned an invalid report decision"));
    };
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ runId, token, reportId: randomUUID(), message })}\n`);
    });
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.byteLength > 1024) {
        socket.destroy();
        finish(new Error("Parent returned an oversized report decision"));
        return;
      }
      const newline = data.indexOf(0x0a);
      if (newline < 0) return;
      let value: unknown;
      try {
        value = JSON.parse(data.subarray(0, newline).toString("utf8")) as unknown;
      } catch {
        finish(new Error("Parent returned a malformed report decision"));
        return;
      }
      if (isRecord(value) && value.accepted === true) finish(undefined, { accepted: true });
      else if (isRecord(value) && value.accepted === false && typeof value.reason === "string") {
        finish(undefined, { accepted: false, reason: value.reason });
      } else finish(new Error("Parent returned an invalid report decision"));
      socket.end();
    });
    socket.once("error", (error) => finish(error));
  });
}

const reportTool = defineTool({
  name: "report_to_parent",
  label: "Report to parent",
  description:
    "Send a short progress report to the parent agent. The call returns when the parent accepts or rejects it; it does not wait for a reply.",
  parameters: Type.Object({
    message: Type.String({ description: "A concise progress report for the parent agent." }),
  }),
  async execute(_toolCallId, { message }) {
    const decision = await submitReport(message);
    return {
      content: [
        {
          type: "text",
          text: decision.accepted
            ? "Parent accepted the report."
            : `Parent rejected the report: ${decision.reason}`,
        },
      ],
      details: decision,
      ...(decision.accepted ? {} : { isError: true }),
    };
  },
});

export default function reportExtension(pi: ExtensionAPI): void {
  if (!process.env[SOCKET_ENV] || !process.env[TOKEN_ENV] || !process.env[RUN_ID_ENV]) return;
  pi.registerTool(reportTool);
}

export function getReportExtensionPath(): string {
  return fileURLToPath(import.meta.url);
}
