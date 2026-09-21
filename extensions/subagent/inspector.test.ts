import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  TuiMainScreen,
  type Terminal,
  visibleWidth,
} from "@earendil-works/pi-tui";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import subagentExtension from "./index.js";
import { AgentInspectorComponent, AgentInspectorStore } from "./inspector.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
});

function registration() {
  const commands: Record<
    string,
    { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }
  > = {};
  const shortcuts: Record<
    string,
    { description?: string; handler: (ctx: unknown) => Promise<void> }
  > = {};
  subagentExtension({
    on() {},
    registerTool() {},
    registerCommand(name: string, definition: (typeof commands)[string]) {
      commands[name] = definition;
    },
    registerShortcut(name: string, definition: (typeof shortcuts)[string]) {
      shortcuts[name] = definition;
    },
  } as any);
  return { commands, shortcuts };
}

describe("subagent inspector registration", () => {
  it("registers the /agent-inspector command and Ctrl+Shift+A shortcut", () => {
    const { commands, shortcuts } = registration();

    expect(commands["agent-inspector"]?.description).toContain("running");
    expect(shortcuts["ctrl+shift+a"]?.description).toContain("running");
  });

  it("closes its overlay only once through pi's custom UI completion", async () => {
    const { commands } = registration();
    let component: AgentInspectorComponent | undefined;
    const hide = vi.fn();
    const open = commands["agent-inspector"].handler("", {
      mode: "tui",
      ui: {
        custom: (factory: any, options: any) =>
          new Promise<void>((resolve) => {
            component = factory(
              { requestRender() {}, terminal: { rows: 20, columns: 80 } },
              plainTheme,
              new KeybindingsManager(TUI_KEYBINDINGS),
              () => {
                hide();
                resolve();
              },
            );
            options.onHandle?.({ hide });
          }),
      },
    });
    component?.handleInput("\x1b");
    await open;
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("does not open terminal UI outside TUI mode", async () => {
    const { commands } = registration();
    const notify = vi.fn();
    const custom = vi.fn();

    await commands["agent-inspector"].handler("", {
      mode: "json",
      ui: { notify, custom },
    });

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("TUI mode"), "error");
    expect(custom).not.toHaveBeenCalled();
  });
});

function executionFixture() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "inspector-integration-"));
  cleanup.push(() => fs.rmSync(project, { recursive: true, force: true }));
  vi.stubEnv("PI_CODING_AGENT_DIR", project);
  const agents = path.join(project, ".pi", "agents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(
    path.join(agents, "worker.md"),
    "---\nname: worker\ndescription: Test worker\n---\n",
  );
  const children: Array<ReturnType<typeof child>> = [];
  function child() {
    return Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      send(event: unknown) {
        this.stdout.emit("data", `${JSON.stringify(event)}\n`);
      },
    });
  }
  vi.mocked(spawn).mockImplementation(() => {
    const process = child();
    children.push(process);
    return process as never;
  });
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const shortcuts: Record<string, any> = {};
  const hooks: Record<string, () => void> = {};
  subagentExtension({
    registerTool(tool: any) {
      tools[tool.name] = tool;
    },
    registerCommand(name: string, definition: any) {
      commands[name] = definition;
    },
    registerShortcut(name: string, definition: any) {
      shortcuts[name] = definition;
    },
    on(name: string, callback: () => void) {
      hooks[name] = callback;
    },
  } as any);
  const views: AgentInspectorComponent[] = [];
  const renders = vi.fn();
  const ctx = {
    cwd: project,
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
    ui: {
      notify: vi.fn(),
      custom: vi.fn(
        (factory: any) =>
          new Promise<void>((done) => {
            views.push(
              factory(
                { requestRender: renders, terminal: { rows: 100, columns: 120 } },
                plainTheme,
                new KeybindingsManager(TUI_KEYBINDINGS),
                done,
              ),
            );
          }),
      ),
    },
  };
  cleanup.push(() => hooks.session_shutdown());
  return {
    project,
    children,
    commands,
    shortcuts,
    hooks,
    views,
    ctx,
    renders,
    execute: (params: unknown, signal?: AbortSignal) =>
      tools.agent.execute(
        `call-${children.length}`,
        { agentScope: "project", confirmProjectAgents: false, ...Object(params) },
        signal,
        undefined,
        ctx,
      ),
    output: () => views[views.length - 1].render(120).join("\n"),
  };
}

describe("subagent inspector live bridge", () => {
  it("opens once through command or shortcut, reopens, and closes on shutdown without cancelling runs", async () => {
    const fixture = executionFixture();
    const execution = fixture.execute({ agent: "worker", task: "Review" });
    await vi.waitFor(() => expect(fixture.children).toHaveLength(1));
    const firstOpen = fixture.commands["agent-inspector"].handler("", fixture.ctx);
    await fixture.shortcuts["ctrl+shift+a"].handler(fixture.ctx);
    expect(fixture.views).toHaveLength(1);
    fixture.views[0].handleInput("\r");
    fixture.views[0].handleInput("\x1b");
    fixture.views[0].handleInput("\x1b");
    await firstOpen;
    const rendersBefore = fixture.renders.mock.calls.length;
    fixture.children[0].send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Still running" },
    });
    expect(fixture.renders).toHaveBeenCalledTimes(rendersBefore);
    const secondOpen = fixture.shortcuts["ctrl+shift+a"].handler(fixture.ctx);
    expect(fixture.output()).toContain("Still running");
    fixture.hooks.session_shutdown();
    await secondOpen;
    expect(fixture.children[0].kill).not.toHaveBeenCalled();
    fixture.children[0].emit("close", 0);
    await execution;
    const thirdOpen = fixture.commands["agent-inspector"].handler("", fixture.ctx);
    expect(fixture.output()).toContain("No subagent runs.");
    fixture.views.at(-1)?.handleInput("\x1b");
    await thirdOpen;
  });

  it.each(["parallel", "chain"])(
    "keeps %s invocations of the same agent separate",
    async (mode) => {
      const fixture = executionFixture();
      const task = { agent: "worker", task: "Same task" };
      const execution = fixture.execute(
        mode === "chain" ? { chain: [task, task] } : { tasks: [task, task] },
      );
      await vi.waitFor(() => expect(fixture.children.length).toBeGreaterThan(0));
      fixture.children[0].send({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "First response" },
      });
      fixture.children[0].emit("close", 0);
      await vi.waitFor(() => expect(fixture.children).toHaveLength(2));
      fixture.children[1].send({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Second response" },
      });
      const open = fixture.commands["agent-inspector"].handler("", fixture.ctx);
      const output = fixture.output();
      expect(output).toContain("run-1");
      expect(output).toContain("run-2");
      expect(output).toContain("First response");
      expect(output).toContain("Second response");
      fixture.children[1].emit("close", 0);
      await execution;
      fixture.views[0].handleInput("\x1b");
      await open;
    },
  );

  it("stops one parallel run while its sibling continues", async () => {
    const fixture = executionFixture();
    const execution = fixture.execute({
      tasks: [
        { agent: "worker", task: "First" },
        { agent: "worker", task: "Second" },
      ],
    });
    await vi.waitFor(() => expect(fixture.children).toHaveLength(2));

    const open = fixture.commands["agent-inspector"].handler("", fixture.ctx);
    fixture.views[0].handleInput("\r");
    expect(fixture.output()).toContain("run-2");
    fixture.children[1].send({
      type: "tool_execution_start",
      toolCallId: "tool",
      toolName: "bash",
      args: { command: "sleep 100" },
    });
    fixture.views[0].handleInput("x");

    expect(fixture.children[1].kill).toHaveBeenCalledWith("SIGTERM");
    expect(fixture.children[0].kill).not.toHaveBeenCalled();
    fixture.children[1].emit("close", null, "SIGTERM");
    fixture.children[0].emit("close", 0);
    const result = await execution;

    expect(result.details.results[1].stopReason).toBe("aborted");
    expect(fixture.output()).toContain("run-2 · worker · ■ aborted");
    expect(fixture.output()).toContain("tool · bash · ■ aborted");
    fixture.views[0].handleInput("\x1b");
    const list = fixture.output();
    expect(list).toContain("run-1 · worker · ✓ completed");
    expect(list).toContain("run-2 · worker · ■ aborted");
    fixture.views[0].handleInput("\x1b");
    await open;
  });

  it("does not spawn a fallback after a stop between attempts", async () => {
    const fixture = executionFixture();
    fs.writeFileSync(
      path.join(fixture.project, ".pi", "agents", "worker.md"),
      "---\nname: worker\ndescription: Test worker\nmodel: test/fallback\n---\n",
    );
    const execution = fixture.execute({ agent: "worker", task: "Review", model: "test/primary" });
    await vi.waitFor(() => expect(fixture.children).toHaveLength(1));

    const open = fixture.commands["agent-inspector"].handler("", fixture.ctx);
    fixture.views[0].handleInput("\r");
    fixture.children[0].stderr.emit("data", "No API key");
    fixture.children[0].emit("close", 1);
    fixture.views[0].handleInput("x");

    await execution;
    expect(fixture.children).toHaveLength(1);
    expect(fixture.output()).toContain("run-1 · worker · ■ aborted");
    fixture.views[0].handleInput("\x1b");
    fixture.views[0].handleInput("\x1b");
    await open;
  });

  it("keeps model fallback attempts in one run and shows the current model", async () => {
    const fixture = executionFixture();
    fs.writeFileSync(
      path.join(fixture.project, ".pi", "agents", "worker.md"),
      "---\nname: worker\ndescription: Test worker\nmodel: test/fallback\n---\n",
    );
    const execution = fixture.execute({ agent: "worker", task: "Review", model: "test/primary" });
    await vi.waitFor(() => expect(fixture.children).toHaveLength(1));
    const open = fixture.commands["agent-inspector"].handler("", fixture.ctx);
    fixture.views[0].handleInput("\r");
    expect(fixture.output()).toContain("test/primary");
    fixture.children[0].stderr.emit("data", "No API key");
    fixture.children[0].emit("close", 1);
    await vi.waitFor(() => expect(fixture.children).toHaveLength(2));
    expect(fixture.output()).toContain("test/fallback");
    expect(fixture.output()).toContain("run-1");
    expect(fixture.output()).not.toContain("run-2");
    fixture.children[1].emit("close", 0);
    await execution;
    fixture.hooks.session_shutdown();
    await open;
  });

  it.each(["signal", "spawn error", "abort"])(
    "shows %s termination without a false completed status",
    async (termination) => {
      const fixture = executionFixture();
      const controller = new AbortController();
      const execution = fixture.execute({ agent: "worker", task: "Review" }, controller.signal);
      await vi.waitFor(() => expect(fixture.children).toHaveLength(1));
      fixture.children[0].send({
        type: "tool_execution_start",
        toolCallId: "tool",
        toolName: "bash",
        args: { command: "sleep 100" },
      });
      const open = fixture.commands["agent-inspector"].handler("", fixture.ctx);
      fixture.views[0].handleInput("\r");
      if (termination === "spawn error")
        fixture.children[0].emit("error", new Error("spawn failed"));
      else {
        if (termination === "abort") controller.abort();
        fixture.children[0].emit("close", null, "SIGTERM");
      }
      await execution;
      expect(fixture.output()).toContain(termination === "abort" ? "aborted" : "failed");
      expect(fixture.output()).not.toContain("completed");
      fixture.hooks.session_shutdown();
      await open;
    },
  );
  it("shows message updates and tool activity before the child process finishes", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-inspector-test-"));
    const agentDir = path.join(project, ".pi", "agents");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews changes\n---\nReview carefully.",
    );

    const process = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(process as never);

    const tools: Record<string, any> = {};
    let openInspector: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
    let component: AgentInspectorComponent | undefined;
    let resolveCustom: (() => void) | undefined;
    const customPromise = new Promise<void>((resolve) => {
      resolveCustom = resolve;
    });
    subagentExtension({
      registerTool(tool: any) {
        tools[tool.name] = tool;
      },
      registerCommand(
        name: string,
        command: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        if (name === "agent-inspector") openInspector = command;
      },
      registerShortcut() {},
      on() {},
    } as any);

    const ctx = {
      cwd: project,
      hasUI: false,
      mode: "tui",
      model: undefined,
      sessionManager: { getSessionFile: () => path.join(project, "session.jsonl") },
      ui: {
        custom: async (
          factory: (
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: () => void,
          ) => unknown,
        ) => {
          component = factory(
            { requestRender: vi.fn(), terminal: { rows: 30, columns: 80 } },
            plainTheme,
            new KeybindingsManager(TUI_KEYBINDINGS),
            () => resolveCustom?.(),
          ) as AgentInspectorComponent;
          return customPromise;
        },
        notify: vi.fn(),
      },
    };

    const open = openInspector?.handler("", ctx);
    await vi.waitFor(() => expect(component).toBeDefined());

    const execution = tools.agent.execute(
      "call-1",
      {
        agent: "reviewer",
        task: "Review the patch",
        agentScope: "project",
        confirmProjectAgents: false,
      },
      undefined,
      undefined,
      ctx,
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());

    const startMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model: "provider/fixture",
    };
    process.stdout.emit(
      "data",
      `${JSON.stringify({ type: "message_start", message: startMessage })}\n`,
    );
    const deltaOne = {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "live " },
    };
    const deltaTwo = {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "answer" },
    };
    process.stdout.emit("data", `${JSON.stringify(deltaOne)}\n`);
    process.stdout.emit("data", `${JSON.stringify(deltaTwo)}\n`);
    process.stdout.emit(
      "data",
      `${JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "src/index.ts" } })}\n`,
    );
    process.stdout.emit(
      "data",
      `${JSON.stringify({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "read", partialResult: { content: [{ type: "text", text: "file contents" }] } })}\n`,
    );
    expect(component).toBeDefined();
    expect(component?.render(80).join("\n")).toContain("live answer");
    component?.handleInput("\r");
    const detail = component?.render(80).join("\n") ?? "";
    expect(detail).toContain("read");
    expect(detail).toContain("src/index.ts");
    expect(detail).toContain("file contents");

    process.stdout.emit(
      "data",
      `${JSON.stringify({ type: "message_end", message: { ...startMessage, content: [{ type: "text", text: "live answer" }] } })}\n`,
    );
    process.stdout.emit(
      "data",
      `${JSON.stringify({ type: "tool_execution_end", toolCallId: "tool-1", result: { content: [{ type: "text", text: "finished" }] }, isError: false })}\n`,
    );
    const finalizedDetail = component?.render(80).join("\n") ?? "";
    expect(finalizedDetail).toContain("finished");
    expect(finalizedDetail).not.toContain("file contents");
    expect(finalizedDetail.match(/live answer/g)).toHaveLength(1);

    process.stdout.emit(
      "data",
      `${JSON.stringify({
        type: "message_end",
        message: {
          ...startMessage,
          content: [{ type: "text", text: "Second turn without deltas" }],
        },
      })}\n`,
    );
    expect(component?.render(80).join("\n")).toContain("Second turn without deltas");
    expect(
      component
        ?.render(80)
        .join("\n")
        .match(/live answer/g),
    ).toHaveLength(1);

    process.emit("close", 0);
    resolveCustom?.();
    await execution;
    await open;
    expect(component?.render(80).join("\n")).toContain("completed");
    fs.rmSync(project, { recursive: true, force: true });
  });
});

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
};

function bodyOf(rows: string[]) {
  return rows.slice(1, -1);
}

function inner(line: string) {
  return line.slice(2, -2);
}

function selectedRow(rows: string[]) {
  return bodyOf(rows).find((line) => line.includes("→ "));
}

function inspectorView(store: AgentInspectorStore, rows = 20, columns = 100) {
  const tui = { requestRender: vi.fn(), terminal: { rows, columns } };
  const done = vi.fn();
  const component = new AgentInspectorComponent(
    tui,
    plainTheme,
    new KeybindingsManager(TUI_KEYBINDINGS),
    store,
    done,
  );
  return { component, tui, done };
}

describe("subagent inspector store", () => {
  it("stops only running runs and clears the stopper when a run finishes", () => {
    const store = new AgentInspectorStore();
    const run = store.start({ agent: "worker", task: "Review" });
    const runId = store.snapshot()[0].id;
    const stopper = vi.fn();
    run.setStopper(stopper);

    expect(store.stop(runId)).toBe(true);
    expect(stopper).toHaveBeenCalledOnce();

    run.finish("aborted");
    expect(store.stop(runId)).toBe(false);
  });
});

describe("subagent inspector TUI", () => {
  it("stops a running run only from its detail view", () => {
    const store = new AgentInspectorStore();
    const finished = store.start({ agent: "finished", task: "Done" });
    finished.finish("completed");
    const running = store.start({ agent: "running", task: "Work" });
    const stopper = vi.fn();
    running.setStopper(stopper);
    const { component } = inspectorView(store);

    expect(component.render(80).at(-1)).not.toContain("x stop");
    component.handleInput("x");
    expect(stopper).not.toHaveBeenCalled();

    component.handleInput("\r");
    expect(component.render(80).at(-1)).toContain("x stop");
    component.handleInput("x");
    expect(stopper).toHaveBeenCalledOnce();

    running.finish("aborted");
    expect(component.render(80).join("\n")).toContain("■ aborted");
    expect(component.render(80).at(-1)).not.toContain("x stop");
    component.handleInput("x");
    expect(stopper).toHaveBeenCalledOnce();

    component.handleInput("\x1b");
    component.handleInput("\x1b[B");
    component.handleInput("x");
    expect(stopper).toHaveBeenCalledOnce();
    component.dispose();
  });

  it("renders in pi's overlay and keeps Escape from reaching the parent view", () => {
    let input: (data: string) => void = () => {};
    const write = vi.fn();
    const terminal: Terminal = {
      rows: 24,
      columns: 80,
      kittyProtocolActive: false,
      start(onInput) {
        input = onInput;
      },
      stop() {},
      drainInput: async () => {},
      write,
      moveBy() {},
      hideCursor() {},
      showCursor() {},
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
      setTitle() {},
      setProgress() {},
    };
    const tui = new TuiMainScreen(terminal);
    cleanup.push(() => tui.stop());
    const parentInput = vi.fn();
    const parent = { render: () => ["Parent view"], invalidate() {}, handleInput: parentInput };
    tui.addChild(parent);
    tui.setFocus(parent);
    const store = new AgentInspectorStore();
    const run = store.start({ agent: "worker", task: "Review" });
    const component = new AgentInspectorComponent(
      tui,
      plainTheme,
      new KeybindingsManager(TUI_KEYBINDINGS),
      store,
      () => tui.hideOverlay(),
    );
    tui.start();
    tui.showOverlay(component, { width: "80%", maxHeight: "80%" });
    input("\r");
    run.appendText("Visible live output");
    tui.renderNow();
    expect(write.mock.calls.map(([text]) => text).join("")).toContain("Visible live output");
    input("\x1b");
    expect(tui.hasOverlay()).toBe(true);
    input("\x1b");
    expect(tui.hasOverlay()).toBe(false);
    expect(parentInput).not.toHaveBeenCalled();
    expect(run.status()).toBe("running");
  });

  it("draws a framed panel with the title and keys embedded in the borders", () => {
    const store = new AgentInspectorStore();
    store.start({ agent: "reviewer", task: "Review the patch" });
    const { component } = inspectorView(store);
    const rows = component.render(80);
    expect(rows[0].startsWith("┌")).toBe(true);
    expect(rows[0]).toContain("Subagent runs");
    expect(rows[0].endsWith("┐")).toBe(true);
    expect(rows.at(-1)?.startsWith("└")).toBe(true);
    expect(rows.at(-1)).toContain("Esc close");
    expect(rows.at(-1)?.endsWith("┘")).toBe(true);
    expect(bodyOf(rows).every((line) => line.startsWith("│") && line.endsWith("│"))).toBe(true);
    expect(rows.every((line) => visibleWidth(line) === 80)).toBe(true);
    component.dispose();
  });

  it("marks the selected run with the selector arrow and the selected background", () => {
    const store = new AgentInspectorStore();
    store.start({ agent: "a", task: "First" });
    store.start({ agent: "b", task: "Second" });
    const component = new AgentInspectorComponent(
      { requestRender: vi.fn(), terminal: { rows: 20, columns: 80 } },
      { fg: plainTheme.fg, bg: (_color: string, text: string) => `<bg>${text}</bg>` },
      new KeybindingsManager(TUI_KEYBINDINGS),
      store,
      vi.fn(),
    );
    const rows = component.render(80);
    const selected = selectedRow(rows);
    expect(selected).toContain("<bg>");
    expect(selected).toContain("→ ");
    expect(selected).toContain("run-2");
    expect(
      bodyOf(rows)
        .filter((line) => line !== selected)
        .every((line) => !line.includes("<bg>")),
    ).toBe(true);
    component.dispose();
  });

  it("colors run status with the icon vocabulary of the agent tool", () => {
    const store = new AgentInspectorStore();
    const running = store.start({ agent: "a", task: "T" });
    const finished = store.start({ agent: "b", task: "T" });
    finished.finish("completed");
    const failed = store.start({ agent: "c", task: "T" });
    failed.finish("failed");
    const { component } = inspectorView(store);
    const output = component.render(80).join("\n");
    expect(output).toContain("⏳");
    expect(output).toContain("✓");
    expect(output).toContain("✗");
    running.finish("aborted");
    expect(component.render(80).join("\n")).toContain("■");
    component.dispose();
  });

  it("scrolls at the overlay width, pauses on older output, and follows again at End", () => {
    const store = new AgentInspectorStore();
    const run = store.start({ agent: "reviewer", task: "Review", model: "test/model" });
    run.setText(Array.from({ length: 40 }, (_, i) => `row-${i} ${"x".repeat(50)}`).join("\n"));
    const { component, tui } = inspectorView(store);
    component.render(30);
    component.handleInput("\r");
    const latest = component.render(30);
    component.handleInput("\x1b[A");
    const previous = component.render(30);
    // One Up key scrolls exactly one displayed row, not one unwrapped source row.
    const bodyText = (rows: string[]) => bodyOf(rows).map(inner);
    expect(bodyText(previous).slice(1)).toEqual(bodyText(latest).slice(0, -1));
    run.messageStart();
    run.appendText("\nnewest output");
    expect(component.render(30).join("\n")).not.toContain("newest output");
    component.handleInput("\x1b[F");
    expect(component.render(30).join("\n")).toContain("newest output");
    component.handleInput("\x1b[H");
    expect(component.render(30).join("\n")).toContain("Task:");
    tui.terminal.rows = 8;
    tui.terminal.columns = 12;
    const resized = component.render(12);
    expect(resized.length).toBeLessThanOrEqual(6);
    expect(resized.every((line) => visibleWidth(line) === 12)).toBe(true);
    component.dispose();
  });
  it("keeps the active output and run status visible after long tool results", () => {
    const store = new AgentInspectorStore();
    const run = store.start({ agent: "reviewer", task: "Review" });
    run.messageEnd("First response");
    run.toolStart("tool-1", "read", {});
    run.toolEnd("tool-1", Array.from({ length: 60 }, (_, i) => `tool line ${i}`).join("\n"), false);
    const { component } = inspectorView(store);
    component.handleInput("\r");
    component.render(80);
    run.messageStart();
    run.appendText("Live response after tool");
    const output = component.render(80).join("\n");
    expect(output).toContain("Live response after tool");
    expect(output).toContain("run-1 · reviewer · ⏳ running");
    run.finish("completed");
    expect(component.render(80).join("\n")).toContain("run-1 · reviewer · ✓ completed");
    component.dispose();
  });

  it("keeps aggregate output bounded and retains the latest text and tool output", () => {
    const store = new AgentInspectorStore();
    const run = store.start({ agent: "reviewer", task: "t".repeat(20_000) });
    run.appendText("old response" + "x".repeat(30_000) + "LATEST RESPONSE");
    for (let index = 0; index < 20; index++) {
      run.toolStart(`tool-${index}`, "read", { path: "a".repeat(5_000) });
      run.toolUpdate(`tool-${index}`, "x".repeat(10_000) + `LATEST TOOL ${index}`);
    }
    const { component } = inspectorView(store, 2000, 120);
    component.handleInput("\r");
    const output = component.render(120).join("\n");
    expect(output.length).toBeLessThan(70_000);
    expect(output).toContain("LATEST RESPONSE");
    expect(output).toContain("LATEST TOOL 19");
    expect(output).not.toContain("old response");
    expect(output).toContain("inspector output truncated");
    component.dispose();
  });

  it("colors status words with the same slot as their icons", () => {
    const store = new AgentInspectorStore();
    const finished = store.start({ agent: "b", task: "T" });
    finished.finish("completed");
    const failedRun = store.start({ agent: "c", task: "T" });
    failedRun.finish("failed");
    store.start({ agent: "a", task: "T" });
    const component = new AgentInspectorComponent(
      { requestRender: vi.fn(), terminal: { rows: 20, columns: 80 } },
      {
        fg: (color: string, text: string) => `${color}:${text}`,
        bg: (_color: string, text: string) => text,
      },
      new KeybindingsManager(TUI_KEYBINDINGS),
      store,
      vi.fn(),
    );
    let output = component.render(80).join("\n");
    expect(output).toContain("success:✓ success:completed");
    expect(output).toContain("error:✗ error:failed");
    component.handleInput("\r");
    output = component.render(80).join("\n");
    expect(output).toContain("warning:running");
    component.dispose();
  });

  it("keeps the selected run stable when new runs arrive and pages through a long list", () => {
    const store = new AgentInspectorStore();
    for (let index = 0; index < 30; index++)
      store.start({ agent: "worker", task: `Task ${index}` });
    const { component } = inspectorView(store, 12, 80);
    component.render(80);
    component.handleInput("\x1b[6~");
    const selected = selectedRow(component.render(80));
    expect(selected).toContain("run-24");
    store.start({ agent: "worker", task: "New task" });
    expect(selectedRow(component.render(80))).toBe(selected);
    component.handleInput("\r");
    expect(component.render(80).join("\n")).toContain("run-24");
    component.dispose();
  });

  it("uses configured navigation keys and stops listening after disposal", () => {
    const store = new AgentInspectorStore();
    store.start({ agent: "first", task: "First" });
    store.start({ agent: "second", task: "Second" });
    const tui = { requestRender: vi.fn(), terminal: { rows: 30, columns: 80 } };
    const component = new AgentInspectorComponent(
      tui,
      plainTheme,
      new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "j", "tui.select.cancel": "q" }),
      store,
      vi.fn(),
    );
    component.render(80);
    component.handleInput("j");
    expect(selectedRow(component.render(80))).toContain("first");
    component.handleInput("q");
    const count = tui.requestRender.mock.calls.length;
    store.start({ agent: "third", task: "Third" });
    expect(tui.requestRender).toHaveBeenCalledTimes(count);
  });

  it("bounds unfinished tool activity and keeps the latest activity visible", () => {
    const store = new AgentInspectorStore();
    const run = store.start({ agent: "reviewer", task: "Review" });
    for (let index = 0; index < 110; index++) {
      run.toolStart(`tool-${index}`, "read", { path: `file-${index}` });
    }
    const { component } = inspectorView(store, 1000, 120);
    component.handleInput("\r");
    const output = component.render(120).join("\n");
    expect(output.match(/• tool-/g)?.length).toBeLessThanOrEqual(100);
    expect(output).toContain("tool-109");
    expect(output).toContain("older tool activity omitted");
    component.dispose();
  });

  it("keeps repeated invocations separate and bounds completed history in the list", () => {
    const store = new AgentInspectorStore();
    store.start({ agent: "reviewer", task: "same task" });
    store.start({ agent: "reviewer", task: "same task" });
    for (let i = 0; i < 52; i++) {
      const run = store.start({ agent: "reviewer", task: `history-${i}` });
      run.finish("completed");
    }

    const component = new AgentInspectorComponent(
      { requestRender: vi.fn(), terminal: { rows: 100, columns: 200 } },
      plainTheme,
      {
        matches: (data: string, binding: string) => {
          const keys: Record<string, string> = {
            "tui.select.confirm": "\r",
            "tui.select.cancel": "\x1b",
            "tui.select.up": "k",
            "tui.select.down": "j",
          };
          return data === keys[binding];
        },
      },
      store,
      vi.fn(),
    );
    const output = component.render(200).join("\n");

    expect(output.match(/same task/g)).toHaveLength(2);
    const rows = bodyOf(output.split("\n")).map((row) => inner(row).trimEnd());
    expect(rows.some((row) => row.endsWith("history-0"))).toBe(false);
    expect(rows.some((row) => row.endsWith("history-1"))).toBe(false);
    expect(rows.some((row) => row.endsWith("history-51"))).toBe(true);
  });

  it("labels detail sections and embeds scroll state in the top border", () => {
    const store = new AgentInspectorStore();
    const run = store.start({ agent: "reviewer", task: "Task text", model: "test/model" });
    run.setText(Array.from({ length: 60 }, (_, i) => `line-${i}`).join("\n"));
    const { component } = inspectorView(store, 10);
    component.handleInput("\r");
    let rows = component.render(80);
    expect(rows[0]).toContain("run-1 · reviewer ·");
    expect(rows[0]).toContain("⏳ running");
    expect(rows[0]).toContain("↑");
    expect(rows[0]).not.toContain("↓");
    expect(rows.at(-1)).toContain("following");
    expect(bodyOf(rows).map(inner).join("\n")).toContain("line-59");
    component.handleInput("\x1b[A");
    rows = component.render(80);
    expect(rows[0]).toContain("↑");
    expect(rows[0]).toContain("↓");
    component.handleInput("\x1b[H");
    rows = component.render(80);
    expect(rows[0]).not.toContain("↑");
    expect(rows[0]).toContain("↓");
    const head = bodyOf(rows).map(inner).join("\n");
    expect(head).toContain("Model: test/model");
    expect(head).toContain("Task:");
    expect(head).toContain("Response:");
    component.dispose();
  });

  it("displays live runs, opens details, and unwinds Escape without cancellation", () => {
    const store = new AgentInspectorStore();
    const run = store.start({ agent: "reviewer", task: "Review the patch", model: "model/v1" });
    run.setText("streaming answer");
    run.toolStart("tool-1", "read", { path: "src/index.ts" });
    run.toolUpdate("tool-1", "partial file output");

    const tui = { requestRender: vi.fn(), terminal: { rows: 20, columns: 80 } };
    const done = vi.fn();
    const component = new AgentInspectorComponent(
      tui,
      plainTheme,
      new KeybindingsManager(TUI_KEYBINDINGS),
      store,
      done,
    );

    expect(component.render(80).join("\n")).toContain("reviewer");
    expect(component.render(80).join("\n")).toContain("running");

    component.handleInput("\r");
    const detail = component.render(80).join("\n");
    expect(detail).toContain("Review the patch");
    expect(detail).toContain("streaming answer");
    expect(detail).toContain("read");
    expect(detail).toContain("src/index.ts");

    component.handleInput("\x1b");
    expect(component.render(80).join("\n")).toContain("reviewer");
    component.handleInput("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
    expect(run.status()).toBe("running");
  });
});
