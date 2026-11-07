import * as fs from "node:fs";
import * as os from "node:os";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { createAgentSession as CreateAgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { isJsonRecord, waitForCondition } from "./test-support/pi-rpc-process.js";

const generation = "fedcba9876543210fedcba9876543210";
const sdkPath = process.env.INSPECTION_SDK_PATH;
const earlyFailureMessage = "Simulated inspection failure while the child tool is blocked.";
type InspectionSession = Awaited<ReturnType<typeof CreateAgentSession>>["session"];

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function disposeInspectionSession(session: InspectionSession | undefined): Promise<void> {
  if (!session) return;
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
  }
}

function activities(messages: unknown[]): Record<string, unknown>[] {
  return messages.flatMap((message) => {
    if (!isJsonRecord(message)) return [];
    const records = message.kind === "snapshot" ? message.activities : message.upserts;
    return Array.isArray(records) ? records.filter(isJsonRecord) : [];
  });
}

async function runInspectionScenario({
  failWhileToolBlocked,
}: {
  failWhileToolBlocked: boolean;
}): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "inspection-sdk-"));
  const sourceRoot = sdkPath ? path.join(directory, "source") : process.cwd();
  if (sdkPath) {
    const sdkRoot = fs.realpathSync(sdkPath);
    fs.cpSync(path.resolve("extensions"), path.join(sourceRoot, "extensions"), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, "node_modules"), { recursive: true });
    fs.symlinkSync(
      path.dirname(sdkRoot),
      path.join(sourceRoot, "node_modules", "@earendil-works"),
      "dir",
    );
    const sdkRequire = createRequire(path.join(sdkRoot, "package.json"));
    let typeboxRoot = path.dirname(sdkRequire.resolve("typebox"));
    while (!fs.existsSync(path.join(typeboxRoot, "package.json"))) {
      const parent = path.dirname(typeboxRoot);
      if (parent === typeboxRoot) throw new Error("Cannot find the selected SDK's TypeBox package");
      typeboxRoot = parent;
    }
    fs.symlinkSync(typeboxRoot, path.join(sourceRoot, "node_modules", "typebox"), "dir");
  }
  const sdk: typeof import("@earendil-works/pi-coding-agent") = sdkPath
    ? await import(pathToFileURL(path.join(fs.realpathSync(sdkPath), "dist/index.js")).href)
    : await import("@earendil-works/pi-coding-agent");
  const { createAgentSession, createEventBus, DefaultResourceLoader, SessionManager } = sdk;
  if (sdkPath) {
    const sdkRoot = fs.realpathSync(sdkPath);
    expect(fs.realpathSync(sdk.getPackageDir())).toBe(sdkRoot);
    const sdkManifest = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"));
    const typeboxManifest = JSON.parse(
      fs.readFileSync(path.join(sourceRoot, "node_modules", "typebox", "package.json"), "utf8"),
    );
    expect(typeboxManifest.version).toBe(sdkManifest.dependencies.typebox);
    for (const name of ["pi-ai", "pi-agent-core", "pi-tui"]) {
      const dependency = fs.realpathSync(
        path.join(sourceRoot, "node_modules", "@earendil-works", name),
      );
      expect(
        JSON.parse(fs.readFileSync(path.join(dependency, "package.json"), "utf8")).version,
      ).toBe(sdkManifest.dependencies[`@earendil-works/${name}`]);
    }
  }
  const fixture = path.join(
    sourceRoot,
    "extensions/subagent/test-support/fixtures/inspection-sdk-provider.mjs",
  );
  const extension = path.join(sourceRoot, "extensions/subagent/index.ts");
  const agentDir = path.join(directory, "agent-dir");
  fs.mkdirSync(path.join(directory, ".pi", "agents"), { recursive: true });
  fs.mkdirSync(agentDir);
  fs.writeFileSync(
    path.join(directory, ".pi", "agents", "worker.md"),
    "---\nname: worker\ndescription: Inspection fixture worker\nmodel: fixture/fixture-model\n---\n",
  );
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: [fixture] }));
  const oldEnv = { ...process.env };
  delete process.env.SUBAGENT_MANAGED_CHILD;
  process.env.INSPECTION_FIXTURE_DIR = directory;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(agentDir, "sessions");
  process.env.PI_OFFLINE = "1";
  const bus = createEventBus();
  const messages: unknown[] = [];
  bus.on("workbench.inspection.v1.publish", (message) => messages.push(message));
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir,
    eventBus: bus,
    additionalExtensionPaths: [extension, fixture],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  let session: InspectionSession | undefined;
  let childPid: number | undefined;
  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const model: Model<"openai-completions"> = {
      id: "fixture-model",
      name: "Fixture",
      api: "openai-completions",
      provider: "fixture",
      baseUrl: "http://127.0.0.1/unused",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 512,
    };
    const created = await createAgentSession({
      cwd: directory,
      agentDir,
      model,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });
    const activeSession = created.session;
    session = activeSession;
    bus.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "attach",
      requestId: "0123456789abcdef0123456789abcdef",
      generation,
    });
    expect(messages).toContainEqual(
      expect.objectContaining({ kind: "snapshot", version: 1, activities: [] }),
    );
    await Promise.race([
      activeSession.prompt("Start the inspection worker."),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error(`Parent prompt did not settle: ${JSON.stringify(session?.messages)}`)),
          10_000,
        ),
      ),
    ]);
    expect(
      activeSession.messages.some(
        (message) => message.role === "toolResult" && message.toolName === "agent",
      ),
    ).toBe(true);
    fs.writeFileSync(path.join(directory, "release-child"), "release");
    await waitForCondition(
      () => fs.existsSync(path.join(directory, "tool-started")),
      "the fixture child tool to start",
    );
    childPid = Number(fs.readFileSync(path.join(directory, "child-pid"), "utf8"));
    expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
    if (failWhileToolBlocked) throw new Error(earlyFailureMessage);
    await waitForCondition(
      () =>
        activities(messages).some(
          (activity) =>
            activity.state === "running" &&
            JSON.stringify(activity.items).includes("inspection-live-text") &&
            JSON.stringify(activity.items).includes("inspection_fixture_tool"),
        ),
      "live child text and tool activity",
    );
    const lateGeneration = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    bus.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "attach",
      requestId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      generation: lateGeneration,
    });
    expect(messages).toContainEqual(
      expect.objectContaining({
        kind: "snapshot",
        generation: lateGeneration,
        activities: expect.arrayContaining([expect.objectContaining({ state: "running" })]),
      }),
    );
    bus.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "detach",
      requestId: "cccccccccccccccccccccccccccccccc",
      generation: lateGeneration,
    });
    const detachedCount = messages.length;
    fs.writeFileSync(path.join(directory, "release-tool"), "release");
    await waitForCondition(
      () =>
        activeSession.messages.some(
          (message) => message.role === "custom" && message.customType === "subagent-result",
        ),
      "detached child completion",
    );
    expect(messages).toHaveLength(detachedCount);
    const finalGeneration = "dddddddddddddddddddddddddddddddd";
    bus.emit("workbench.inspection.v1.request", {
      version: 1,
      kind: "attach",
      requestId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      generation: finalGeneration,
    });
    expect(
      activities(messages.slice(detachedCount)).some(
        (activity) =>
          activity.state === "completed" &&
          JSON.stringify(activity.items).includes("inspection-tool-output") &&
          JSON.stringify(activity.items).includes("inspection-child-finished"),
      ),
    ).toBe(true);
  } finally {
    try {
      await disposeInspectionSession(session);
      if (childPid !== undefined) expect(isProcessRunning(childPid)).toBe(false);
    } finally {
      try {
        // Keep the intentional failing scenario safe while checking the normal cleanup path.
        if (session && childPid !== undefined && isProcessRunning(childPid)) {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        }
      } finally {
        process.env = oldEnv;
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  }
}

it("[process integration] publishes async child activity and a late attachment snapshot through the real SDK bus", async () => {
  await runInspectionScenario({ failWhileToolBlocked: false });
}, 45_000);

it("[process integration] stops a blocked child before removing an early-failure fixture", async () => {
  await expect(runInspectionScenario({ failWhileToolBlocked: true })).rejects.toThrow(
    earlyFailureMessage,
  );
}, 45_000);
