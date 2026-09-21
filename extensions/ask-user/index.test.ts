import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
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

function context(mode: ExtensionContext["mode"], ui: Record<string, unknown>): ExtensionContext {
  return {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui,
  } as unknown as ExtensionContext;
}

describe("ask_user", () => {
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

    expect(select).toHaveBeenCalledWith("Should I follow up with the team?", ["Other"]);
    expect(input).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      status: "completed",
      cancelled: false,
      answers: {
        follow_up: { id: "follow_up", kind: "option", value: "Other", label: "Other" },
      },
    });
  });

  it("returns to the option list when Esc leaves custom Other input", async () => {
    type Component = {
      render(width: number): string[];
      handleInput(data: string): void;
    };
    type Factory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (value: unknown) => void,
    ) => Component;

    let component: Component | undefined;
    const custom = vi.fn((factory: Factory) => {
      return new Promise<unknown>((resolve) => {
        component = factory(
          { requestRender() {}, terminal: { rows: 20, columns: 80 } },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          {},
          resolve,
        );
      });
    });
    const tool = registeredTool();

    const execution = tool.execute(
      "call-other-back",
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
      context("tui", { custom }),
    );

    await vi.waitFor(() => expect(custom).toHaveBeenCalledTimes(1));
    component?.handleInput("\x1b[B");
    component?.handleInput("\r");
    expect(component?.render(80).join("\n")).toContain("Esc to go back");

    component?.handleInput("\x1b");
    expect(component?.render(80).join("\n")).toContain("PostgreSQL");
    expect(component?.render(80).join("\n")).toContain("Esc cancel");

    component?.handleInput("\x1b");
    await expect(execution).resolves.toMatchObject({
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
    type Component = {
      render(width: number): string[];
      handleInput(data: string): void;
    };
    type Factory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (value: unknown) => void,
    ) => Component;

    let component: Component | undefined;
    const custom = vi.fn((factory: Factory) => {
      return new Promise<unknown>((resolve) => {
        component = factory(
          { requestRender() {}, terminal: { rows: 20, columns: 80 } },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          {},
          resolve,
        );
      });
    });
    const tool = registeredTool();

    const execution = tool.execute(
      "call-4",
      {
        questions: [
          {
            id: "notes",
            header: "Notes",
            question: "Anything else to consider?",
            options: [{ label: "No additional notes", description: "Keep the defaults" }],
            is_other: true,
          },
        ],
      },
      undefined,
      undefined,
      context("tui", { custom }),
    );

    await vi.waitFor(() => expect(custom).toHaveBeenCalledTimes(1));
    expect(component?.render(80).join("\n")).toContain("Anything else to consider?");
    expect(component?.render(80).join("\n")).toContain("Keep the defaults");

    component?.handleInput("\x1b[B");
    component?.handleInput("\r");
    for (const character of "Use a rollback plan") component?.handleInput(character);
    component?.handleInput("\r");

    const result = await execution;
    expect(result.details).toEqual({
      status: "completed",
      cancelled: false,
      answers: {
        notes: { id: "notes", kind: "text", value: "Use a rollback plan" },
      },
    });
  });

  it("labels the custom choice distinctly when a declared option is named Other", async () => {
    type Component = {
      render(width: number): string[];
      handleInput(data: string): void;
    };
    type Factory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (value: unknown) => void,
    ) => Component;

    let component: Component | undefined;
    const custom = vi.fn((factory: Factory) => {
      return new Promise<unknown>((resolve) => {
        component = factory(
          { requestRender() {}, terminal: { rows: 20, columns: 80 } },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          {},
          resolve,
        );
      });
    });
    const tool = registeredTool();

    const execution = tool.execute(
      "call-other-tui",
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
      context("tui", { custom }),
    );

    await vi.waitFor(() => expect(custom).toHaveBeenCalledTimes(1));
    expect(component?.render(80).join("\n")).toContain("Other (custom answer)");

    component?.handleInput("\r");
    const result = await execution;
    expect(result.details).toEqual({
      status: "completed",
      cancelled: false,
      answers: {
        follow_up: { id: "follow_up", kind: "option", value: "Other", label: "Other" },
      },
    });
  });

  it("opens TUI questions one at a time", async () => {
    type Component = {
      render(width: number): string[];
      handleInput(data: string): void;
    };
    type Factory = (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (value: unknown) => void,
    ) => Component;

    const renderedQuestions: string[] = [];
    const custom = vi.fn((factory: Factory) => {
      return new Promise<unknown>((resolve) => {
        const component = factory(
          { requestRender() {}, terminal: { rows: 20, columns: 80 } },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          {},
          resolve,
        );
        renderedQuestions.push(component.render(80).join("\n"));
        component.handleInput("\r");
      });
    });
    const tool = registeredTool();

    const result = await tool.execute(
      "call-5",
      {
        questions: [
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
      },
      undefined,
      undefined,
      context("tui", { custom }),
    );

    expect(custom).toHaveBeenCalledTimes(2);
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
