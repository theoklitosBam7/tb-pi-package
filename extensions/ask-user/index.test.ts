import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  KeybindingsManager as AppKeybindingsManager,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import askUser, { AskUserParameters, type AskUserDetails } from "./index.js";

type RegisteredAskUserTool = ToolDefinition<typeof AskUserParameters, AskUserDetails>;

function registeredTool(): RegisteredAskUserTool {
  let tool: RegisteredAskUserTool | undefined;
  const pi = {
    registerTool(definition: RegisteredAskUserTool) {
      tool = definition;
    },
  } as unknown as ExtensionAPI;

  askUser(pi);

  if (!tool) throw new Error("ask_user tool was not registered");
  return tool;
}

function context(
  mode: ExtensionContext["mode"],
  ui: Record<string, unknown>,
): ExtensionToolContext {
  const extensionContext = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui,
  } as unknown as ExtensionContext;
  return {
    ...extensionContext,
    tools: [],
    async executeTool() {
      throw new Error("Nested tool execution is not supported by this test context");
    },
  };
}

type AskUserTestQuestion = Parameters<RegisteredAskUserTool["execute"]>[1]["questions"][number];
type TestQuestionComponent = Component & { focused?: boolean };

function tuiQuestion(
  question: AskUserTestQuestion | AskUserTestQuestion[],
  rows = 20,
  columns = 80,
  onCreate?: (component: TestQuestionComponent) => void,
) {
  const terminal = { rows, columns };
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.pageDown": "ctrl+n",
    "tui.select.pageUp": "ctrl+p",
  });
  const components: TestQuestionComponent[] = [];
  const custom = vi.fn(
    (factory: Parameters<ExtensionContext["ui"]["custom"]>[0], _options?: unknown) =>
      new Promise<unknown>((resolve) => {
        const component = factory(
          { requestRender: vi.fn(), terminal } as unknown as TUI,
          {
            fg: (_color: string, text: string) => text,
            bg: (_color: string, text: string) => `\x1b[48;5;236m${text}\x1b[49m`,
            bold: (text: string) => text,
          } as Theme,
          keybindings as unknown as AppKeybindingsManager,
          resolve,
        ) as TestQuestionComponent;
        components.push(component);
        onCreate?.(component);
      }),
  );
  const questions = Array.isArray(question) ? question : [question];
  const execution = registeredTool().execute(
    "preview-test",
    { questions },
    undefined,
    undefined,
    context("tui", { custom }),
  );
  function firstComponent(): TestQuestionComponent {
    const component = components[0];
    if (!component) throw new Error("question component was not created");
    return component;
  }
  return {
    terminal,
    custom,
    get view() {
      return firstComponent();
    },
    execution,
    render: (width = terminal.columns) => firstComponent().render(width).join("\n"),
  };
}

describe("ask_user", () => {
  it("shows question progress across choice, custom-answer, and text-input panels", async () => {
    const panels: string[] = [];
    const ui = tuiQuestion(
      [
        {
          id: "choice",
          header: "Choice",
          question: "Choose one?",
          options: [{ label: "Default" }],
          is_other: true,
        },
        { id: "note", question: "Any notes?" },
      ],
      20,
      80,
      (component) => {
        panels.push(component.render(80).join("\n"));
        if (panels.length === 1) {
          component.handleInput?.("\x1b[B");
          component.handleInput?.("\r");
          panels.push(component.render(80).join("\n"));
          component.handleInput?.("\x1b");
          panels.push(component.render(80).join("\n"));
          component.handleInput?.("\x1b[A");
        } else {
          component.handleInput?.("N");
        }
        component.handleInput?.("\r");
      },
    );

    await expect(ui.execution).resolves.toMatchObject({ details: { status: "completed" } });
    expect(panels[0]).toContain("1/2 Choice");
    expect(panels[1]).toContain("1/2 Choice");
    expect(panels[1]).toContain("Your answer:");
    expect(panels[2]).toContain("1/2 Choice");
    expect(panels[3]).toContain("2/2 Ask user");
    expect(panels[3]).toContain("Your answer:");
  });
  it("frames and fills the focused question in choice and text modes", async () => {
    for (const question of [
      { id: "choice", question: "Choose a release?", options: [{ label: "Rolling release" }] },
      { id: "note", question: "Any notes?" },
    ]) {
      const ui = tuiQuestion(question, 12, 28);
      const lines = ui.view.render(28);
      expect(lines.join("\n")).toContain("1/1 Ask user");
      expect(lines[0]).toContain("─");
      expect(lines.at(-1)).toContain("─");
      expect(lines.slice(1, -1).every((line) => line.startsWith("│") && line.endsWith("│"))).toBe(
        true,
      );
      expect(lines.slice(1, -1).every((line) => line.includes("\x1b[48;5;236m"))).toBe(true);
      expect(lines.every((line) => visibleWidth(line) <= 28)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(10);
      ui.view.handleInput?.("\x1b");
      await expect(ui.execution).resolves.toMatchObject({ details: { status: "cancelled" } });
    }
  });
  it("keeps long choice rows compact and wraps the full selected choice in a preview", async () => {
    const label = "Deploy the application to the production cluster with rolling releases";
    const description =
      "Keep existing sessions alive while moving traffic gradually to the new version.";
    const ui = tuiQuestion(
      {
        id: "deploy",
        question: "Which deployment strategy should we use?",
        options: [{ label, description }, { label: "Wait" }],
      },
      20,
      34,
    );

    const lines = ui.view.render(34);
    expect(lines.some((line) => line.includes("→ Deploy") && !line.includes("sessions"))).toBe(
      true,
    );
    expect(ui.render()).toContain("Preview");
    expect(ui.render()).toContain("production cluster");
    expect(ui.render()).toContain("sessions alive");
    expect(lines.every((line) => visibleWidth(line) <= 34)).toBe(true);
    ui.view.handleInput?.("\r");
    await expect(ui.execution).resolves.toMatchObject({
      details: { answers: { deploy: { label, description } } },
    });
  });

  it("scrolls the selected preview with configured page keys and resets on selection", async () => {
    const ui = tuiQuestion(
      {
        id: "choice",
        question: "Choose one?",
        options: [
          {
            label: "First choice",
            description:
              "first line\nsecond line\nthird line\nfourth line\nfifth line\nsixth line\nseventh line\neighth line\nninth line\ntenth line\neleventh line",
          },
          { label: "Second choice" },
        ],
      },
      12,
      32,
    );
    expect(ui.render()).toContain("first line");
    ui.view.handleInput?.("\x0e"); // ctrl+n, configured pageDown
    expect(ui.render()).toContain("second line");
    expect(ui.render()).not.toContain("first line");
    for (let i = 0; i < 20; i++) ui.view.handleInput?.("\x0e");
    const bottom = ui.render();
    ui.view.handleInput?.("\x0e");
    expect(ui.render()).toBe(bottom);
    ui.view.handleInput?.("\x10"); // ctrl+p, configured pageUp
    expect(ui.render()).not.toBe(bottom);
    for (let i = 0; i < 20; i++) ui.view.handleInput?.("\x10");
    expect(ui.render()).toContain("first line");
    ui.view.handleInput?.("\x0e");
    ui.render();
    ui.view.handleInput?.("\x1b[B");
    expect(ui.render()).toContain("Second choice");
    expect(ui.render()).not.toContain("first line");
    ui.view.handleInput?.("\x1b[A");
    expect(ui.render()).toContain("first line");
    expect(ui.render()).toContain("PgUp/PgDn");
    ui.view.handleInput?.("\r");
    await expect(ui.execution).resolves.toMatchObject({
      details: { answers: { choice: { label: "First choice" } } },
    });
  });

  it("shows a short Other preview and keeps editor Escape behavior", async () => {
    const ui = tuiQuestion({
      id: "choice",
      question: "Choose one?",
      options: [{ label: "Other" }],
      is_other: true,
    });
    ui.render();
    ui.view.handleInput?.("\x1b[B");
    expect(ui.render()).toContain("Enter a custom answer");
    ui.view.handleInput?.("\r");
    expect(ui.render()).toContain("Esc to go back");
    ui.view.handleInput?.("\x1b");
    expect(ui.render()).toContain("Other (custom answer)");
    ui.view.handleInput?.("\x1b");
    await expect(ui.execution).resolves.toMatchObject({ details: { status: "cancelled" } });
  });

  it("keeps the question and selected row visible on short screens and resize", async () => {
    const ui = tuiQuestion(
      {
        id: "choice",
        question: "Which environment should receive the release?",
        options: Array.from({ length: 12 }, (_, i) => ({
          label: `Target ${i} 界`,
          description: "wide 界 text ".repeat(12),
        })),
      },
      12,
      24,
    );
    expect(ui.custom.mock.calls[0]?.[1]).toBeUndefined();
    for (let i = 0; i < 10; i++) ui.view.handleInput?.("\x1b[B");
    for (const [rows, columns] of [
      [12, 24],
      [18, 16],
      [10, 40],
      [24, 50],
    ]) {
      ui.terminal.rows = rows;
      ui.terminal.columns = columns;
      const lines = ui.view.render(columns);
      expect(lines.join("\n")).toContain("Which");
      expect(lines.join("\n")).toContain("release?");
      expect(lines.join("\n")).toContain("→ Target 10");
      expect(lines.join("\n")).toContain("(11/12)");
      expect(lines.length).toBeLessThanOrEqual(Math.min(24, rows - 2));
      expect(lines.every((line) => visibleWidth(line) <= columns)).toBe(true);
    }
    ui.view.handleInput?.("\r");
    await expect(ui.execution).resolves.toMatchObject({
      details: { answers: { choice: { label: "Target 10 界" } } },
    });
  });

  it("uses the last free row for preview instead of its heading", async () => {
    const ui = tuiQuestion(
      {
        id: "one",
        question: "Pick?",
        options: [
          { label: "First", description: "one line of useful detail" },
          { label: "Second" },
        ],
      },
      10,
      40,
    );
    expect(ui.render()).toContain("First");
    expect(ui.render().match(/First/g)?.length).toBe(2);
    expect(ui.render()).not.toContain("Preview");
    ui.view.handleInput?.("\x1b");
    await expect(ui.execution).resolves.toMatchObject({ details: { status: "cancelled" } });
  });

  it("keeps text-only questions free of choice previews", async () => {
    const ui = tuiQuestion({ id: "note", question: "Any notes?" });
    expect(ui.render()).toContain("Your answer:");
    expect(ui.render()).not.toContain("Preview");
    ui.view.handleInput?.("\x1b");
    await expect(ui.execution).resolves.toMatchObject({ details: { status: "cancelled" } });
  });

  it("does not crash when rendering a legacy result after reload", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;

    const tool = registeredTool();
    const renderResult = tool.renderResult;
    if (!renderResult) throw new Error("ask_user result renderer was not registered");

    const component = renderResult(
      {
        content: [{ type: "text", text: "User declined" }],
        details: {
          question: "Which option?",
          options: ["A", "B"],
          answer: null,
          wasCustom: false,
          cancelled: true,
        },
      } as never,
      { expanded: false, isPartial: false },
      theme,
      {
        args: { questions: [] },
        toolCallId: "call-legacy",
        durationMs: undefined,
        outputPad: 0,
        invalidate: vi.fn(),
        lastComponent: undefined,
        state: {},
        cwd: "/tmp",
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded: false,
        showImages: false,
        isError: false,
      },
    );

    let rendered: string[] = [];
    expect(() => {
      rendered = component.render(80);
    }).not.toThrow();
    expect(rendered.join("\n")).toContain("User declined");
  });

  it("collects RPC answers sequentially and preserves answer details", async () => {
    const askedTitles: string[] = [];
    const select = vi.fn(async (_title: string, options: string[]) => {
      askedTitles.push(_title);
      return options[0];
    });
    const input = vi.fn(async (title: string) => {
      askedTitles.push(title);
      return "Keep the migration reversible";
    });
    const tool = registeredTool();

    expect(tool.executionMode).toBe("sequential");

    const result = await tool.execute(
      "call-1",
      {
        questions: [
          {
            id: "database",
            header: "Database",
            question: "Which database should the migration target?",
            options: [
              { label: "PostgreSQL", description: "Production database" },
              { label: "SQLite" },
            ],
          },
          {
            id: "notes",
            header: "Notes",
            question: "Anything else to consider?",
          },
        ],
      },
      undefined,
      undefined,
      context("rpc", { select, input }),
    );

    expect(select).toHaveBeenCalledWith("Database: Which database should the migration target?", [
      "PostgreSQL - Production database",
      "SQLite",
    ]);
    expect(input).toHaveBeenCalledWith("Notes: Anything else to consider?", "Type your answer");
    expect(askedTitles).toEqual([
      "Database: Which database should the migration target?",
      "Notes: Anything else to consider?",
    ]);
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "database: PostgreSQL\nnotes: Keep the migration reversible",
        },
      ],
      details: {
        status: "completed",
        cancelled: false,
        answers: {
          database: {
            id: "database",
            kind: "option",
            value: "PostgreSQL",
            label: "PostgreSQL",
            description: "Production database",
          },
          notes: {
            id: "notes",
            kind: "text",
            value: "Keep the migration reversible",
          },
        },
      },
    });
  });

  it("rejects duplicate question IDs before prompting", async () => {
    const select = vi.fn();
    const input = vi.fn();
    const tool = registeredTool();

    await expect(
      tool.execute(
        "call-duplicate-id",
        {
          questions: [
            {
              id: "choice",
              question: "Database?",
              options: [{ label: "SQLite" }],
            },
            {
              id: "choice",
              question: "Region?",
              options: [{ label: "Europe" }],
            },
          ],
        },
        undefined,
        undefined,
        context("rpc", { select, input }),
      ),
    ).rejects.toThrow('ask_user question IDs must be unique; duplicate ID "choice"');
    expect(select).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
  });

  it("rejects ambiguous RPC option display values before prompting", async () => {
    const select = vi.fn();
    const input = vi.fn();
    const tool = registeredTool();

    await expect(
      tool.execute(
        "call-duplicate-display-value",
        {
          questions: [
            {
              id: "choice",
              question: "Which option?",
              options: [{ label: "A - B" }, { label: "A", description: "B" }],
            },
          ],
        },
        undefined,
        undefined,
        context("rpc", { select, input }),
      ),
    ).rejects.toThrow(
      'ask_user RPC options must have unique display values; duplicate value "A - B"',
    );
    expect(select).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
  });

  it("answers a declared option labeled Other instead of forcing free-form input", async () => {
    const select = vi.fn().mockResolvedValue("Other");
    const input = vi.fn();
    const tool = registeredTool();

    const result = await tool.execute(
      "call-other-option",
      {
        questions: [
          {
            id: "follow_up",
            question: "Should I follow up with the team?",
            options: [{ label: "Other" }],
            is_other: true,
          },
        ],
      },
      undefined,
      undefined,
      context("rpc", { select, input }),
    );

    expect(select).toHaveBeenCalledWith("Should I follow up with the team?", [
      "Other",
      "Other (custom answer)",
    ]);
    expect(input).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      status: "completed",
      cancelled: false,
      answers: {
        follow_up: { id: "follow_up", kind: "option", value: "Other", label: "Other" },
      },
    });
  });

  it("opens custom input from a disambiguated Other choice in RPC mode", async () => {
    const select = vi.fn().mockResolvedValue("Other (custom answer)");
    const input = vi.fn().mockResolvedValue("Use a custom follow-up");
    const tool = registeredTool();

    const result = await tool.execute(
      "call-other-rpc-custom",
      {
        questions: [
          {
            id: "follow_up",
            question: "Should I follow up with the team?",
            options: [{ label: "Other" }],
            is_other: true,
          },
        ],
      },
      undefined,
      undefined,
      context("rpc", { select, input }),
    );

    expect(select).toHaveBeenCalledWith("Should I follow up with the team?", [
      "Other",
      "Other (custom answer)",
    ]);
    expect(input).toHaveBeenCalledWith("Should I follow up with the team?", "Type your answer");
    expect(result.details).toEqual({
      status: "completed",
      cancelled: false,
      answers: {
        follow_up: { id: "follow_up", kind: "text", value: "Use a custom follow-up" },
      },
    });
  });

  it("returns to the option list when Esc leaves custom Other input", async () => {
    const ui = tuiQuestion({
      id: "database",
      question: "Which database should the migration target?",
      options: [{ label: "PostgreSQL" }],
      is_other: true,
    });

    await vi.waitFor(() => expect(ui.custom).toHaveBeenCalledTimes(1));
    ui.view.handleInput?.("\x1b[B");
    ui.view.handleInput?.("\r");
    expect(ui.render()).toContain("Esc to go back");

    ui.view.handleInput?.("\x1b");
    expect(ui.render()).toContain("PostgreSQL");
    expect(ui.render()).toContain("Esc cancel");

    ui.view.handleInput?.("\x1b");
    await expect(ui.execution).resolves.toMatchObject({
      details: { status: "cancelled", cancelled: true, answers: {} },
    });
  });

  it("opens free-form input when the user picks the custom Other choice", async () => {
    const select = vi.fn().mockResolvedValue("Other");
    const input = vi.fn().mockResolvedValue("Use SQLite instead");
    const tool = registeredTool();

    const result = await tool.execute(
      "call-other-choice",
      {
        questions: [
          {
            id: "database",
            question: "Which database should the migration target?",
            options: [{ label: "PostgreSQL" }],
            is_other: true,
          },
        ],
      },
      undefined,
      undefined,
      context("rpc", { select, input }),
    );

    expect(select).toHaveBeenCalledWith("Which database should the migration target?", [
      "PostgreSQL",
      "Other",
    ]);
    expect(input).toHaveBeenCalledWith(
      "Which database should the migration target?",
      "Type your answer",
    );
    expect(result.details).toEqual({
      status: "completed",
      cancelled: false,
      answers: {
        database: { id: "database", kind: "text", value: "Use SQLite instead" },
      },
    });
  });

  it("returns a structured cancellation with partial RPC answers", async () => {
    const select = vi.fn().mockResolvedValue("PostgreSQL - Production database");
    const input = vi.fn().mockResolvedValue(undefined);
    const tool = registeredTool();

    const result = await tool.execute(
      "call-2",
      {
        questions: [
          {
            id: "database",
            question: "Which database should the migration target?",
            options: [{ label: "PostgreSQL", description: "Production database" }],
          },
          {
            id: "notes",
            question: "Anything else to consider?",
          },
        ],
      },
      undefined,
      undefined,
      context("rpc", { select, input }),
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "User cancelled ask_user after 1 answer(s)" }],
      details: {
        status: "cancelled",
        cancelled: true,
        answers: {
          database: {
            id: "database",
            kind: "option",
            value: "PostgreSQL",
            label: "PostgreSQL",
            description: "Production database",
          },
        },
      },
    });
  });

  it("returns a clear result without prompting in non-interactive mode", async () => {
    const select = vi.fn();
    const input = vi.fn();
    const tool = registeredTool();

    const result = await tool.execute(
      "call-3",
      {
        questions: [
          {
            id: "scope",
            question: "Which scope should this cover?",
            options: [{ label: "Current package" }],
          },
        ],
      },
      undefined,
      undefined,
      context("json", { select, input }),
    );

    expect(select).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "ask_user requires an interactive UI; no answers were collected",
        },
      ],
      details: {
        status: "unavailable",
        cancelled: false,
        answers: {},
        reason: "non-interactive",
      },
    });
  });

  it("collects a custom TUI answer through the questionnaire component", async () => {
    const ui = tuiQuestion({
      id: "notes",
      header: "Notes",
      question: "Anything else to consider?",
      options: [{ label: "No additional notes", description: "Keep the defaults" }],
      is_other: true,
    });

    await vi.waitFor(() => expect(ui.custom).toHaveBeenCalledTimes(1));
    expect(ui.render()).toContain("Anything else to consider?");
    expect(ui.render()).toContain("Keep the defaults");

    ui.view.handleInput?.("\x1b[B");
    ui.view.handleInput?.("\r");
    for (const character of "Use a rollback plan") ui.view.handleInput?.(character);
    ui.view.handleInput?.("\r");

    const result = await ui.execution;
    expect(result.details).toEqual({
      status: "completed",
      cancelled: false,
      answers: {
        notes: { id: "notes", kind: "text", value: "Use a rollback plan" },
      },
    });
  });

  it("labels the custom choice distinctly when a declared option is named Other", async () => {
    const ui = tuiQuestion({
      id: "follow_up",
      question: "Should I follow up with the team?",
      options: [{ label: "Other" }],
      is_other: true,
    });

    await vi.waitFor(() => expect(ui.custom).toHaveBeenCalledTimes(1));
    expect(ui.render()).toContain("Other (custom answer)");

    ui.view.handleInput?.("\r");
    const result = await ui.execution;
    expect(result.details).toEqual({
      status: "completed",
      cancelled: false,
      answers: {
        follow_up: { id: "follow_up", kind: "option", value: "Other", label: "Other" },
      },
    });
  });

  it("opens TUI questions one at a time", async () => {
    const renderedQuestions: string[] = [];
    const ui = tuiQuestion(
      [
        {
          id: "first",
          question: "First question?",
          options: [{ label: "First answer" }],
        },
        {
          id: "second",
          question: "Second question?",
          options: [{ label: "Second answer" }],
        },
      ],
      20,
      80,
      (component) => {
        renderedQuestions.push(component.render(80).join("\n"));
        component.handleInput?.("\r");
      },
    );

    const result = await ui.execution;

    expect(ui.custom).toHaveBeenCalledTimes(2);
    expect(renderedQuestions[0]).toContain("First question?");
    expect(renderedQuestions[1]).toContain("Second question?");
    expect(result.details).toEqual({
      status: "completed",
      cancelled: false,
      answers: {
        first: { id: "first", kind: "option", value: "First answer", label: "First answer" },
        second: {
          id: "second",
          kind: "option",
          value: "Second answer",
          label: "Second answer",
        },
      },
    });
  });
});
