import { connect } from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import reportExtension, { createReportServer } from "./report.js";

const servers: Array<{ close(): Promise<void> }> = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  vi.unstubAllEnvs();
});

function sendReport(socketPath: string, record: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(record)}\n`));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      const newline = data.indexOf("\n");
      if (newline >= 0) {
        socket.end();
        resolve(JSON.parse(data.slice(0, newline)) as unknown);
      }
    });
    socket.on("error", reject);
  });
}

describe("child reports", () => {
  it("does not register the reporting tool without managed child credentials", () => {
    vi.stubEnv("SUBAGENT_REPORT_SOCKET", "");
    vi.stubEnv("SUBAGENT_REPORT_TOKEN", "");
    vi.stubEnv("SUBAGENT_REPORT_RUN_ID", "");
    const registerTool = vi.fn();

    reportExtension({ registerTool } as never);

    expect(registerTool).not.toHaveBeenCalled();
  });

  it("registers the reporting tool for a managed child", () => {
    vi.stubEnv("SUBAGENT_REPORT_SOCKET", "/tmp/private.sock");
    vi.stubEnv("SUBAGENT_REPORT_TOKEN", "private-token");
    vi.stubEnv("SUBAGENT_REPORT_RUN_ID", "run-7");
    const registerTool = vi.fn();

    reportExtension({ registerTool } as never);

    expect(registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "report_to_parent" }),
    );
  });

  it("returns the manager acceptance decision to the child", async () => {
    const onReport = vi.fn(async () => ({ accepted: true as const }));
    const server = await createReportServer({ runId: "run-7", onReport });
    servers.push(server);
    expect(server.environment.SUBAGENT_MANAGED_CHILD).toBe("1");

    await expect(
      sendReport(server.socketPath, {
        runId: "run-7",
        token: server.token,
        reportId: "report-1",
        message: "Found the failing test.",
      }),
    ).resolves.toEqual({ accepted: true });
    expect(onReport).toHaveBeenCalledWith({
      runId: "run-7",
      reportId: "report-1",
      message: "Found the failing test.",
    });
  });

  it("rejects reports from a different run without calling the manager", async () => {
    const onReport = vi.fn(async () => ({ accepted: true as const }));
    const server = await createReportServer({ runId: "run-7", onReport });
    servers.push(server);

    await expect(
      sendReport(server.socketPath, {
        runId: "run-8",
        token: server.token,
        reportId: "report-1",
        message: "Wrong child",
      }),
    ).resolves.toEqual({ accepted: false, reason: "Report authentication failed" });
    expect(onReport).not.toHaveBeenCalled();
  });

  it("returns a manager rejection so the child can see it", async () => {
    const server = await createReportServer({
      runId: "run-7",
      onReport: async () => ({ accepted: false as const, reason: "Run is already complete" }),
    });
    servers.push(server);

    await expect(
      sendReport(server.socketPath, {
        runId: "run-7",
        token: server.token,
        reportId: "report-2",
        message: "Late update",
      }),
    ).resolves.toEqual({ accepted: false, reason: "Run is already complete" });
  });

  it("rejects malformed token bytes without crashing the report server", async () => {
    const onReport = vi.fn(async () => ({ accepted: true as const }));
    const server = await createReportServer({ runId: "run-7", onReport });
    servers.push(server);

    await expect(
      sendReport(server.socketPath, {
        runId: "run-7",
        token: "🔒".repeat(16),
        reportId: "report-3",
        message: "Invalid token",
      }),
    ).resolves.toEqual({ accepted: false, reason: "Report authentication failed" });
    expect(onReport).not.toHaveBeenCalled();
  });

  it("accepts duplicate report IDs once while the first report is pending", async () => {
    const release = deferred<{ accepted: true }>();
    const onReport = vi.fn(() => release.promise);
    const server = await createReportServer({ runId: "run-7", onReport });
    servers.push(server);
    const report = {
      runId: "run-7",
      token: server.token,
      reportId: "report-duplicate",
      message: "One progress event",
    };

    const first = sendReport(server.socketPath, report);
    await vi.waitFor(() => expect(onReport).toHaveBeenCalledTimes(1));
    const duplicate = sendReport(server.socketPath, report);
    release.resolve({ accepted: true });

    await expect(first).resolves.toEqual({ accepted: true });
    await expect(duplicate).resolves.toEqual({ accepted: true });
    expect(onReport).toHaveBeenCalledTimes(1);
  });

  it("rejects reports when the in-flight report queue is full", async () => {
    const release = deferred<{ accepted: true }>();
    const onReport = vi.fn(() => release.promise);
    const server = await createReportServer({
      runId: "run-7",
      maxPendingReports: 1,
      onReport,
    });
    servers.push(server);

    const first = sendReport(server.socketPath, {
      runId: "run-7",
      token: server.token,
      reportId: "report-active",
      message: "Still being handled",
    });
    await vi.waitFor(() => expect(onReport).toHaveBeenCalledTimes(1));

    await expect(
      sendReport(server.socketPath, {
        runId: "run-7",
        token: server.token,
        reportId: "report-overflow",
        message: "Too many reports",
      }),
    ).resolves.toEqual({ accepted: false, reason: "Report queue is full" });

    release.resolve({ accepted: true });
    await expect(first).resolves.toEqual({ accepted: true });
  });

  it("removes its temporary directory if the socket path is invalid", async () => {
    const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-rpt-failure-"));
    const longTempDirectory = path.join(parentDirectory, "x".repeat(90));
    await fs.mkdir(longTempDirectory);
    vi.stubEnv("TMPDIR", longTempDirectory);
    const before = await fs.readdir(longTempDirectory);

    await expect(
      createReportServer({ runId: "run-7", onReport: () => ({ accepted: true }) }),
    ).rejects.toThrow();

    await expect(fs.readdir(longTempDirectory)).resolves.toEqual(before);
    await fs.rm(parentDirectory, { recursive: true, force: true });
  });
});
