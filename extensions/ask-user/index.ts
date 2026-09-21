import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Editor,
  Key,
  matchesKey,
  SelectList,
  Text,
  type Component,
  type EditorTheme,
  type SelectItem,
  type SelectListTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const AskUserOptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(Type.String({ description: "Optional explanation for the option" })),
});

const AskUserQuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  header: Type.Optional(Type.String({ description: "Short label for the question" })),
  question: Type.String({ description: "Question to ask the user" }),
  options: Type.Optional(Type.Array(AskUserOptionSchema, { description: "Selectable options" })),
  is_other: Type.Optional(
    Type.Boolean({ description: "Add an option that lets the user enter a custom answer" }),
  ),
});

export const AskUserParameters = Type.Object({
  questions: Type.Array(AskUserQuestionSchema, {
    minItems: 1,
    description: "Questions to ask the user in order",
  }),
});

export type AskUserParams = Static<typeof AskUserParameters>;
export type AskUserQuestion = AskUserParams["questions"][number];
export type AskUserOption = NonNullable<AskUserQuestion["options"]>[number];

export type AskUserAnswer =
  | {
      id: string;
      kind: "option";
      value: string;
      label: string;
      description?: string;
    }
  | {
      id: string;
      kind: "text";
      value: string;
    };

export type AskUserAnswers = Record<string, AskUserAnswer>;

export type AskUserDetails =
  | {
      status: "completed";
      cancelled: false;
      answers: AskUserAnswers;
    }
  | {
      status: "cancelled";
      cancelled: true;
      answers: AskUserAnswers;
    }
  | {
      status: "unavailable";
      cancelled: false;
      answers: AskUserAnswers;
      reason: "non-interactive";
    };

type QuestionInteraction = { kind: "answer"; answer: AskUserAnswer } | { kind: "cancelled" };

const OTHER_CHOICE = "Other";

type RpcDialogs = {
  ui: ExtensionContext["ui"];
  signal: AbortSignal | undefined;
};

function textAnswer(id: string, value: string): AskUserAnswer {
  return { id, kind: "text", value };
}

function optionAnswer(id: string, option: AskUserOption): AskUserAnswer {
  return {
    id,
    kind: "option",
    value: option.label,
    label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }),
  };
}

function createQuestionComponent(
  question: AskUserQuestion,
  tui: TUI,
  theme: Theme,
  signal: AbortSignal | undefined,
  done: (result: QuestionInteraction) => void,
): Component & { focused: boolean; dispose?(): void } {
  const options = question.options ?? [];
  const inputModeInitially = options.length === 0;
  let inputMode = inputModeInitially;
  let finished = false;
  let focused = false;

  const selectListTheme: SelectListTheme = {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  };
  const editorTheme: EditorTheme = {
    borderColor: (text) => theme.fg("accent", text),
    selectList: selectListTheme,
  };
  const editor = new Editor(tui, editorTheme);
  const optionItems: SelectItem[] = options.map((option, index) => ({
    value: `option:${index}`,
    label: option.label,
    description: option.description,
  }));
  if (question.is_other) {
    // Mirror the RPC rule: when a declared option already claims the plain
    // "Other" label, relabel the custom row so the two stay distinguishable.
    const otherLabelTaken = options.some(
      (option) => option.label === OTHER_CHOICE && !option.description,
    );
    optionItems.push({
      value: "other",
      label: otherLabelTaken ? `${OTHER_CHOICE} (custom answer)` : OTHER_CHOICE,
      description: "Enter a custom answer",
    });
  }

  const optionByValue = new Map<string, AskUserOption>();
  for (const [index, option] of options.entries()) {
    optionByValue.set(`option:${index}`, option);
  }
  const selectList = new SelectList(
    optionItems,
    Math.min(Math.max(optionItems.length, 1), 8),
    selectListTheme,
  );
  const container = new Container();

  function cancel(): void {
    finish({ kind: "cancelled" });
  }

  function finish(result: QuestionInteraction): void {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", cancel);
    done(result);
  }

  function rebuild(): void {
    container.clear();
    container.addChild(
      new Text(theme.fg("accent", theme.bold(question.header ?? "Ask user")), 1, 0),
    );
    container.addChild(new Text(theme.fg("text", question.question), 1, 0));

    if (inputMode) {
      container.addChild(new Text(theme.fg("muted", "Your answer:"), 1, 0));
      container.addChild(editor);
      const escapeHint = inputModeInitially ? "Esc to cancel" : "Esc to go back";
      container.addChild(new Text(theme.fg("dim", `Enter to submit • ${escapeHint}`), 1, 0));
    } else {
      container.addChild(selectList);
      container.addChild(
        new Text(theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"), 1, 0),
      );
    }
  }

  editor.onSubmit = (value) => {
    finish({ kind: "answer", answer: textAnswer(question.id, value) });
  };

  selectList.onSelect = (item) => {
    if (item.value === "other") {
      inputMode = true;
      editor.setText("");
      rebuild();
      tui.requestRender();
      return;
    }

    const option = optionByValue.get(item.value);
    if (option) finish({ kind: "answer", answer: optionAnswer(question.id, option) });
  };
  selectList.onCancel = () => finish({ kind: "cancelled" });

  if (signal) {
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) queueMicrotask(cancel);
  }

  rebuild();

  return {
    get focused() {
      return focused;
    },
    set focused(value: boolean) {
      focused = value;
      editor.focused = value;
    },
    render: (width) => container.render(width),
    invalidate: () => {
      container.invalidate();
      rebuild();
    },
    dispose: () => signal?.removeEventListener("abort", cancel),
    handleInput(data) {
      if (inputMode) {
        if (matchesKey(data, Key.escape)) {
          if (inputModeInitially) {
            finish({ kind: "cancelled" });
          } else {
            inputMode = false;
            rebuild();
            tui.requestRender();
          }
          return;
        }
        editor.handleInput(data);
        tui.requestRender();
        return;
      }

      selectList.handleInput(data);
      tui.requestRender();
    },
  };
}

function validateQuestionIds(questions: AskUserQuestion[]): void {
  const ids = new Set<string>();
  for (const question of questions) {
    if (ids.has(question.id)) {
      throw new Error(`ask_user question IDs must be unique; duplicate ID "${question.id}"`);
    }
    ids.add(question.id);
  }
}

function answersById(answers: AskUserAnswer[]): AskUserAnswers {
  const entries: Array<[string, AskUserAnswer]> = answers.map((answer) => [answer.id, answer]);
  return Object.fromEntries(entries);
}

function questionTitle(question: AskUserQuestion): string {
  return question.header ? `${question.header}: ${question.question}` : question.question;
}

function displayOption(option: AskUserOption): string {
  return option.description ? `${option.label} - ${option.description}` : option.label;
}

function rpcOptionDisplays(options: AskUserOption[]): string[] {
  const displayedOptions = options.map(displayOption);
  const seen = new Set<string>();
  for (const displayedOption of displayedOptions) {
    if (seen.has(displayedOption)) {
      throw new Error(
        `ask_user RPC options must have unique display values; duplicate value "${displayedOption}"`,
      );
    }
    seen.add(displayedOption);
  }
  return displayedOptions;
}

function rpcInput(dialogs: RpcDialogs, question: AskUserQuestion): Promise<string | undefined> {
  const title = questionTitle(question);
  return dialogs.signal
    ? dialogs.ui.input(title, "Type your answer", { signal: dialogs.signal })
    : dialogs.ui.input(title, "Type your answer");
}

function rpcSelect(
  dialogs: RpcDialogs,
  question: AskUserQuestion,
  options: string[],
): Promise<string | undefined> {
  const title = questionTitle(question);
  return dialogs.signal
    ? dialogs.ui.select(title, options, { signal: dialogs.signal })
    : dialogs.ui.select(title, options);
}

async function collectAnswers(
  questions: AskUserQuestion[],
  ask: (question: AskUserQuestion) => Promise<QuestionInteraction>,
): Promise<AskUserDetails> {
  const answers: AskUserAnswer[] = [];

  for (const question of questions) {
    const interaction = await ask(question);
    if (interaction.kind === "cancelled") {
      return { status: "cancelled", cancelled: true, answers: answersById(answers) };
    }
    answers.push(interaction.answer);
  }

  return { status: "completed", cancelled: false, answers: answersById(answers) };
}

async function askRpcQuestion(
  dialogs: RpcDialogs,
  question: AskUserQuestion,
): Promise<QuestionInteraction> {
  if (dialogs.signal?.aborted) return { kind: "cancelled" };

  const options = question.options ?? [];
  if (options.length === 0) {
    const value = await rpcInput(dialogs, question);
    return value === undefined || dialogs.signal?.aborted
      ? { kind: "cancelled" }
      : { kind: "answer", answer: textAnswer(question.id, value) };
  }

  // RPC select options are plain strings, so the custom-choice label must not
  // shadow a declared option that already claims it.
  const displayedOptions = rpcOptionDisplays(options);
  if (question.is_other && !displayedOptions.includes(OTHER_CHOICE)) {
    displayedOptions.push(OTHER_CHOICE);
  }

  const selected = await rpcSelect(dialogs, question, displayedOptions);
  if (selected === undefined || dialogs.signal?.aborted) return { kind: "cancelled" };

  const option = options[displayedOptions.indexOf(selected)];
  if (option) return { kind: "answer", answer: optionAnswer(question.id, option) };

  if (question.is_other && selected === OTHER_CHOICE) {
    const value = await rpcInput(dialogs, question);
    return value === undefined || dialogs.signal?.aborted
      ? { kind: "cancelled" }
      : { kind: "answer", answer: textAnswer(question.id, value) };
  }

  return { kind: "cancelled" };
}

function contentText(details: AskUserDetails): string {
  switch (details.status) {
    case "completed":
      return Object.values(details.answers)
        .map((answer) => `${answer.id}: ${answer.value}`)
        .join("\n");
    case "cancelled":
      return `User cancelled ask_user after ${Object.keys(details.answers).length} answer(s)`;
    case "unavailable":
      return "ask_user requires an interactive UI; no answers were collected";
    default: {
      const exhaustive: never = details;
      return exhaustive;
    }
  }
}

function result(details: AskUserDetails): AgentToolResult<AskUserDetails> {
  return {
    content: [{ type: "text", text: contentText(details) }],
    details,
  };
}

function nonInteractiveResult(): AgentToolResult<AskUserDetails> {
  return result({
    status: "unavailable",
    cancelled: false,
    answers: {},
    reason: "non-interactive",
  });
}

function resultText(toolResult: AgentToolResult<AskUserDetails>): string {
  const text = toolResult.content.find((item) => item.type === "text");
  return text?.type === "text" ? text.text : "";
}

export default function askUser(pi: ExtensionAPI): void {
  const tool: ToolDefinition<typeof AskUserParameters, AskUserDetails> = {
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user one or more structured questions and return their answers. Use for clarification and decisions that need user input.",
    promptSnippet: "Ask the user structured questions and wait for answers",
    promptGuidelines: [
      "Use ask_user when clarification or a decision requires direct user input.",
      "Do not use ask_user for secrets or passwords.",
    ],
    parameters: AskUserParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      validateQuestionIds(params.questions);

      if (ctx.mode === "tui" && ctx.hasUI) {
        return result(
          await collectAnswers(params.questions, (question) =>
            ctx.ui.custom<QuestionInteraction>((tui, theme, _keybindings, done) =>
              createQuestionComponent(question, tui, theme, signal, done),
            ),
          ),
        );
      }

      if (ctx.mode === "rpc" && ctx.hasUI) {
        const dialogs: RpcDialogs = { ui: ctx.ui, signal };
        return result(
          await collectAnswers(params.questions, (question) => askRpcQuestion(dialogs, question)),
        );
      }

      return nonInteractiveResult();
    },
    renderCall(args, theme) {
      const count = args.questions.length;
      const label = `${count} question${count === 1 ? "" : "s"}`;
      return new Text(
        theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", label),
        0,
        0,
      );
    },
    renderResult(toolResult, _options, theme) {
      const details = toolResult.details;
      if (!details) {
        return new Text(resultText(toolResult), 0, 0);
      }

      switch (details.status) {
        case "completed":
          return new Text(
            Object.values(details.answers)
              .map(
                (answer) =>
                  `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.id)}: ${answer.value}`,
              )
              .join("\n"),
            0,
            0,
          );
        case "cancelled":
          return new Text(
            theme.fg("warning", `Cancelled after ${Object.keys(details.answers).length} answer(s)`),
            0,
            0,
          );
        case "unavailable":
          return new Text(theme.fg("warning", "Interactive UI unavailable"), 0, 0);
        default:
          return new Text(resultText(toolResult), 0, 0);
      }
    },
  };

  pi.registerTool(tool);
}
