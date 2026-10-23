import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

const indexFile = new URL("./index.ts", import.meta.url).pathname;
const poolFile = new URL("./pool.ts", import.meta.url).pathname;
const acpFixture = [
  'process.stdin.setEncoding("utf8"); let buffer = "";',
  'process.stdin.on("data", (chunk) => { buffer += chunk; let newline;',
  'while ((newline = buffer.indexOf("\\n")) >= 0) {',
  "const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);",
  'const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
  'if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });',
  'if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "local" } });',
  'if (message.method === "session/prompt") {',
  "const task = message.params.prompt[0].text;",
  'send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "local", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `completed: ${task}` } } } });',
  'send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });',
  "}",
  "}});",
].join("\n");

const HostResultSchema = Type.Object({
  tool: Type.Object({
    content: Type.Array(Type.Object({ text: Type.String() })),
    isError: Type.Optional(Type.Boolean()),
  }),
  notifications: Type.Array(Type.Object({ message: Type.String(), level: Type.String() })),
});

const host = String.raw`
const fs = require("node:fs");
const Module = require("node:module");
const ts = require("typescript");
const indexFile = process.argv[1];
const poolFile = process.argv[2];
const params = JSON.parse(process.argv[3]);
const compile = (file) => {
  const source = fs.readFileSync(file, "utf8");
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
};
const poolModule = new Module(poolFile, module);
poolModule.filename = poolFile;
poolModule.paths = Module._nodeModulePaths(process.cwd());
poolModule._compile(compile(poolFile), poolFile);
const extensionModule = new Module(indexFile, module);
extensionModule.filename = indexFile;
extensionModule.paths = Module._nodeModulePaths(process.cwd());
const requireExtension = extensionModule.require.bind(extensionModule);
extensionModule.require = (request) => request === "./pool.js" ? poolModule.exports : requireExtension(request);
extensionModule._compile(compile(indexFile), indexFile);
const tools = new Map();
const commands = new Map();
const notifications = [];
let shutdown;
extensionModule.exports.default({
  on(event, handler) { if (event === "session_shutdown") shutdown = handler; },
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand(name, command) { commands.set(name, command); },
});
(async () => {
  const tool = await tools.get("acp_agent").execute("call", params, undefined, () => {}, { cwd: process.cwd() });
  await commands.get("acp").handler("", { ui: { notify(message, level) { notifications.push({ message, level }); } } });
  shutdown?.();
  process.stdout.write(JSON.stringify({ tool, notifications }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;

function runExtension(config?: unknown, options: { mode?: number; symlink?: boolean } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-acp-index-"));
  const agentDirectory = path.join(home, ".pi", "agent");
  fs.mkdirSync(agentDirectory, { recursive: true });
  const configFile = path.join(agentDirectory, "acp-agents.json");
  if (config !== undefined) {
    const source = path.join(home, "source.json");
    fs.writeFileSync(source, JSON.stringify(config), { mode: options.mode ?? 0o600 });
    if (options.symlink) fs.symlinkSync(source, configFile);
    else fs.renameSync(source, configFile);
    if (!options.symlink && options.mode !== undefined) fs.chmodSync(configFile, options.mode);
  }

  const result = spawnSync(
    process.execPath,
    ["-e", host, indexFile, poolFile, JSON.stringify({ agent: "worker", task: "inspect" })],
    { cwd: process.cwd(), env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 10000 },
  );
  fs.rmSync(home, { recursive: true, force: true });
  if (result.status !== 0)
    throw new Error(result.stderr || `ACP host exited with ${result.status}`);
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Value.Check(HostResultSchema, parsed))
    throw new Error("ACP host returned an invalid result");
  return parsed;
}

const validConfig = {
  worker: {
    command: process.execPath,
    args: ["-e", acpFixture],
    timeoutMs: 3000,
    startupTimeoutMs: 1000,
    inactivityTimeoutMs: 1000,
  },
};

describe("ACP extension configuration boundary", () => {
  it("lists a valid agent and executes it through the registered tool", () => {
    const result = runExtension(validConfig);

    expect(result.notifications).toEqual([{ message: "ACP agents: worker", level: "info" }]);
    expect(result.tool.content).toEqual([{ type: "text", text: "completed: inspect" }]);
    expect(result.tool.isError).toBeUndefined();
  });

  it("reports a missing configuration through both registered interfaces", () => {
    const result = runExtension();

    expect(result.notifications).toEqual([{ message: "No ACP agents configured.", level: "info" }]);
    expect(result.tool).toMatchObject({
      content: [{ text: "ACP agent is not configured" }],
      isError: true,
    });
  });

  it.each([
    ["array top level", [], /Invalid ACP config/],
    ["null top level", null, /Invalid ACP config/],
    [
      "bad agent name",
      { "Bad Name": { command: process.execPath, args: [] } },
      /Invalid ACP agent entry/,
    ],
    ["non-object agent entry", { worker: null }, /Invalid ACP agent entry/],
    [
      "invalid agent schema",
      { worker: { command: process.execPath, args: [1] } },
      /ACP agents require an absolute executable path and string arguments/,
    ],
    [
      "relative executable",
      { worker: { command: "node", args: [] } },
      /ACP agents require an absolute executable path and string arguments/,
    ],
    [
      "timeout below minimum",
      { worker: { command: process.execPath, args: [], timeoutMs: 0 } },
      /Invalid ACP timeout for worker: timeoutMs/,
    ],
    [
      "timeout above maximum",
      { worker: { command: process.execPath, args: [], timeoutMs: 3_600_001 } },
      /Invalid ACP timeout for worker: timeoutMs/,
    ],
  ])("uses the same validation error for the command and tool: %s", (_case, config, expected) => {
    const result = runExtension(config);
    const toolError = result.tool.content[0]?.text;

    expect(toolError).toMatch(expected);
    expect(result.tool.isError).toBe(true);
    expect(result.notifications).toEqual([{ message: toolError, level: "error" }]);
  });

  it("rejects a symlinked configuration file", () => {
    const result = runExtension(validConfig, { symlink: true });

    expect(result.tool.content[0]?.text).toMatch(/owner-only regular file/);
    expect(result.notifications).toEqual([
      { message: result.tool.content[0]?.text, level: "error" },
    ]);
  });

  it("rejects configuration files with group or world permissions", () => {
    const result = runExtension(validConfig, { mode: 0o644 });

    expect(result.tool.content[0]?.text).toMatch(/owner-only regular file/);
    expect(result.notifications).toEqual([
      { message: result.tool.content[0]?.text, level: "error" },
    ]);
  });

  it("rejects configuration files larger than 64 KiB", () => {
    const config = {
      worker: { ...validConfig.worker, padding: "x".repeat(65_537) },
    };
    const result = runExtension(config);

    expect(result.tool.content[0]?.text).toBe("ACP config too large");
    expect(result.notifications).toEqual([{ message: "ACP config too large", level: "error" }]);
  });
});
