import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getSubagentThinkingLabel, type SubagentThinkingLevel } from "./agents.js";

const MAX_COMPLETED_RUNS = 50;
const MAX_RUN_CHARS = 64_000;
const MAX_TEXT_CHARS = 16_000;
const MAX_TOOL_ACTIVITIES = 100;
const TRUNCATION_NOTICE = "[inspector output truncated; older content omitted]";
const ACTIVITY_NOTICE = "[older tool activity omitted to stay within the inspector budget]";

export type AgentInspectorStatus = "running" | "completed" | "failed" | "aborted";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function boundedTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${TRUNCATION_NOTICE}\n${text.slice(-(max - TRUNCATION_NOTICE.length - 1))}`;
}

export function getInspectorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(getInspectorText).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (Array.isArray(value.content)) return getInspectorText(value.content);
  return "";
}

export function getInspectorMessageText(message: unknown): string {
  return isRecord(message) && message.role === "assistant" ? getInspectorText(message.content) : "";
}

interface InspectorResponse {
  sequence: number;
  text: string;
}

interface InspectorTool {
  sequence: number;
  id: string;
  name: string;
  args: string;
  status: AgentInspectorStatus;
  output: string;
}

interface AgentInspectorRun {
  id: string;
  agent: string;
  task: string;
  model?: string;
  thinking?: SubagentThinkingLevel;
  status: AgentInspectorStatus;
  text: string;
  responses: InspectorResponse[];
  tools: InspectorTool[];
  activityTruncated: boolean;
}

export interface AgentInspectorRunHandle {
  setModel(model: string | undefined): void;
  setText(text: string): void;
  messageStart(text?: string): void;
  appendText(delta: string): void;
  messageEnd(text: string): void;
  toolStart(id: string, name: string, args: Record<string, unknown>): void;
  toolUpdate(id: string, output: string): void;
  toolEnd(id: string, output: string, isError: boolean): void;
  setStopper(stopper: () => void): void;
  finish(status: Exclude<AgentInspectorStatus, "running">): void;
  status(): AgentInspectorStatus;
}

function boundedArgs(args: Record<string, unknown>): string {
  try {
    return boundedTail(JSON.stringify(args), 2_000);
  } catch {
    return "[arguments unavailable]";
  }
}

export class AgentInspectorStore {
  private readonly runs = new Map<string, AgentInspectorRun>();
  private readonly stoppers = new Map<string, () => void>();
  private readonly listeners = new Set<() => void>();
  private sequence = 0;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.runs.clear();
    this.stoppers.clear();
    this.notify();
  }

  stop(id: string): boolean {
    const stopper = this.stoppers.get(id);
    if (!stopper) return false;
    stopper();
    return true;
  }

  snapshot(): readonly AgentInspectorRun[] {
    return [...this.runs.values()].reverse();
  }

  start(options: {
    agent: string;
    task: string;
    model?: string;
    thinking?: SubagentThinkingLevel;
  }): AgentInspectorRunHandle {
    const run: AgentInspectorRun = {
      id: `run-${++this.sequence}`,
      agent: boundedTail(options.agent, 256),
      task: boundedTail(options.task, 4_000),
      model: options.model,
      thinking: options.thinking,
      status: "running",
      text: "",
      responses: [],
      tools: [],
      activityTruncated: false,
    };
    this.runs.set(run.id, run);
    this.notify();
    let activitySequence = 0;
    let activeMessage: InspectorResponse | undefined;
    const isActive = () => this.runs.get(run.id) === run && run.status === "running";
    const message = () => {
      if (!activeMessage) {
        activeMessage = { sequence: ++activitySequence, text: "" };
        run.responses.push(activeMessage);
      }
      return activeMessage;
    };
    const publish = () => {
      // Bound the source buffers as well as the displayed transcript.
      while (
        run.responses.length > 1 &&
        (run.responses.length > 100 ||
          run.responses.reduce((size, item) => size + item.text.length, 0) > MAX_TEXT_CHARS)
      ) {
        run.responses.shift();
        run.activityTruncated = true;
      }
      run.text = run.responses
        .map((item) => item.text)
        .filter(Boolean)
        .join("\n\n");
      const size = () =>
        run.task.length +
        run.text.length * 2 +
        run.tools.reduce(
          (total, tool) =>
            total + tool.args.length + tool.output.length + tool.name.length + tool.id.length,
          0,
        );
      while (
        run.tools.length > 0 &&
        (run.tools.length > MAX_TOOL_ACTIVITIES || size() > MAX_RUN_CHARS)
      ) {
        run.tools.shift();
        run.activityTruncated = true;
      }
      this.notify();
    };
    const updateTool = (id: string, output: string, status?: InspectorTool["status"]) => {
      if (!isActive()) return;
      const tool = run.tools.find((item) => item.id === id);
      if (!tool) return;
      tool.output = boundedTail(output, 8_000);
      if (status) tool.status = status;
      publish();
    };

    return {
      setModel: (model) => {
        if (!isActive()) return;
        run.model = model;
        this.notify();
      },
      setText: (text) => {
        if (!isActive()) return;
        run.responses = [];
        activeMessage = undefined;
        message().text = boundedTail(text, MAX_TEXT_CHARS);
        activeMessage = undefined;
        publish();
      },
      messageStart: (text = "") => {
        if (!isActive()) return;
        activeMessage = undefined;
        message().text = boundedTail(text, MAX_TEXT_CHARS);
        publish();
      },
      appendText: (delta) => {
        if (!isActive() || !delta) return;
        const current = message();
        current.text = boundedTail(current.text + delta, MAX_TEXT_CHARS);
        publish();
      },
      messageEnd: (text) => {
        if (!isActive()) return;
        const current = message();
        current.text = boundedTail(text || current.text, MAX_TEXT_CHARS);
        activeMessage = undefined;
        publish();
      },
      toolStart: (id, name, args) => {
        if (!isActive()) return;
        const existing = run.tools.find((tool) => tool.id === id);
        if (!existing) {
          run.tools.push({
            sequence: ++activitySequence,
            id,
            name,
            args: boundedArgs(args),
            status: "running",
            output: "",
          });
        }
        publish();
      },
      toolUpdate: (id, output) => updateTool(id, output),
      toolEnd: (id, output, isError) => updateTool(id, output, isError ? "failed" : "completed"),
      setStopper: (stopper) => {
        if (!isActive()) return;
        this.stoppers.set(run.id, stopper);
      },
      finish: (status) => {
        if (!isActive()) return;
        this.stoppers.delete(run.id);
        run.status = status;
        for (const tool of run.tools) {
          if (tool.status === "running") tool.status = status === "aborted" ? "aborted" : "failed";
        }
        const completed = [...this.runs.values()].filter((item) => item.status !== "running");
        for (const item of completed.slice(0, Math.max(0, completed.length - MAX_COMPLETED_RUNS))) {
          this.runs.delete(item.id);
        }
        this.notify();
      },
      status: () => this.runs.get(run.id)?.status ?? "failed",
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

type Tui = Pick<TUI, "requestRender"> & { terminal: Pick<TUI["terminal"], "rows" | "columns"> };
type Keybindings = Pick<KeybindingsManager, "matches">;
type InspectorTheme = Pick<Theme, "fg" | "bg">;

function wrapLines(lines: string[], width: number): string[] {
  return lines.flatMap((line) =>
    line.split("\n").flatMap((part) => {
      const wrapped = wrapTextWithAnsi(part, Math.max(1, width));
      return wrapped.length ? wrapped : [""];
    }),
  );
}

export class AgentInspectorComponent {
  private readonly unsubscribe: () => void;
  private selectedIndex = 0;
  private selectedRunId: string | undefined;
  private detail = false;
  private detailOffset = 0;
  private followLatest = true;
  private disposed = false;
  private renderedWidth = 1;

  constructor(
    private readonly tui: Tui,
    private readonly theme: InspectorTheme,
    private readonly keybindings: Keybindings,
    private readonly store: AgentInspectorStore,
    private readonly done: () => void,
  ) {
    this.unsubscribe = store.subscribe(() => tui.requestRender());
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    const matches = (binding: Parameters<Keybindings["matches"]>[1]) =>
      this.keybindings.matches(data, binding);
    const runs = this.store.snapshot();
    if (matches("tui.select.cancel")) {
      if (this.detail) {
        this.detail = false;
        this.tui.requestRender();
      } else this.close();
      return;
    }
    if (this.detail) {
      const run = this.selectedRun(runs);
      if (data === "x" && run?.status === "running") {
        this.store.stop(run.id);
        this.tui.requestRender();
        return;
      }
      const lines = run ? this.detailLines(run, this.contentWidth()) : [];
      const page = Math.max(1, this.bodyHeight());
      const maxOffset = Math.max(0, lines.length - page);
      const current = this.followLatest ? maxOffset : Math.min(this.detailOffset, maxOffset);
      if (matches("tui.select.up")) this.detailOffset = Math.max(0, current - 1);
      else if (matches("tui.select.down")) this.detailOffset = Math.min(maxOffset, current + 1);
      else if (matches("tui.select.pageUp")) this.detailOffset = Math.max(0, current - page);
      else if (matches("tui.select.pageDown"))
        this.detailOffset = Math.min(maxOffset, current + page);
      else if (matches("tui.altScreen.top")) this.detailOffset = 0;
      else if (matches("tui.altScreen.bottom")) this.detailOffset = maxOffset;
      else return;
      this.followLatest = this.detailOffset === maxOffset;
    } else if (matches("tui.select.up")) this.moveSelection(runs, -1);
    else if (matches("tui.select.down")) this.moveSelection(runs, 1);
    else if (matches("tui.select.pageUp"))
      this.moveSelection(runs, -Math.max(1, this.bodyHeight() - 1));
    else if (matches("tui.select.pageDown"))
      this.moveSelection(runs, Math.max(1, this.bodyHeight() - 1));
    else if (matches("tui.select.confirm") && this.selectedRun(runs)) {
      this.detail = true;
      this.followLatest = true;
    } else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.renderedWidth = Math.max(1, Math.min(width, this.tui.terminal.columns));
    const runs = this.store.snapshot();
    const run = this.selectedRun(runs);
    const bodyHeight = this.bodyHeight();
    let title: string;
    let body: string[];
    let above = 0;
    let below = 0;
    if (this.detail) {
      title = run ? this.detailTitle(run) : this.theme.fg("borderAccent", "Subagent runs");
      const lines = run
        ? this.detailLines(run, this.contentWidth())
        : [this.theme.fg("muted", "Selected run is no longer available.")];
      const maxOffset = Math.max(0, lines.length - bodyHeight);
      this.detailOffset = this.followLatest ? maxOffset : Math.min(this.detailOffset, maxOffset);
      const visible = lines.slice(this.detailOffset, this.detailOffset + bodyHeight);
      above = this.detailOffset;
      below = Math.max(0, lines.length - this.detailOffset - visible.length);
      body = visible.map((line) => this.frameRow(line));
    } else {
      title = this.theme.fg("borderAccent", "Subagent runs");
      const entries = this.listEntries(runs, run);
      const selectedLine = Math.max(
        0,
        entries.findIndex((entry) => entry.selected),
      );
      const offset = Math.max(0, Math.min(selectedLine, entries.length - bodyHeight));
      const visible = entries.slice(offset, offset + bodyHeight);
      above = offset;
      below = Math.max(0, entries.length - offset - visible.length);
      body = visible.map((entry) => this.frameRow(entry.line, entry.selected));
    }
    const footer = this.theme.fg(
      "dim",
      this.detail
        ? `Esc back · ↑↓ scroll · PgUp/PgDn · Home/End · ${this.followLatest ? "following" : "paused"}${run?.status === "running" ? " · x stop" : ""}`
        : "↑↓ select · Enter inspect · Esc close",
    );
    return [
      this.borderRow("┌", "┐", title, this.scrollIndicator(above, below)),
      ...body,
      this.borderRow("└", "┘", footer),
    ]
      .slice(0, this.overlayHeight())
      .map((line) => truncateToWidth(line, this.renderedWidth, ""));
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }

  close(): void {
    if (this.disposed) return;
    this.dispose();
    this.done();
  }

  private statusSlot(status: AgentInspectorStatus) {
    switch (status) {
      case "running":
        return "warning" as const;
      case "completed":
        return "success" as const;
      case "failed":
        return "error" as const;
      case "aborted":
        return "muted" as const;
    }
  }

  private statusIcon(status: AgentInspectorStatus): string {
    const icons: Record<AgentInspectorStatus, string> = {
      running: "⏳",
      completed: "✓",
      failed: "✗",
      aborted: "■",
    };
    return this.theme.fg(this.statusSlot(status), icons[status]);
  }

  private statusText(status: AgentInspectorStatus): string {
    return this.theme.fg(this.statusSlot(status), status);
  }

  private detailTitle(run: AgentInspectorRun): string {
    return (
      this.theme.fg("borderAccent", `${run.id} · ${run.agent} · `) +
      this.statusIcon(run.status) +
      " " +
      this.statusText(run.status)
    );
  }

  private contentWidth(): number {
    return Math.max(1, this.renderedWidth - 4);
  }

  private frameRow(line: string, selected = false): string {
    const content = truncateToWidth(line, this.contentWidth(), "…", true);
    return (
      this.theme.fg("border", "│ ") +
      (selected ? this.theme.bg("selectedBg", content) : content) +
      this.theme.fg("border", " │")
    );
  }

  private borderRow(
    cornerStart: string,
    cornerEnd: string,
    content: string,
    trailing?: string,
  ): string {
    const dash = (count: number) => this.theme.fg("border", "─".repeat(Math.max(0, count)));
    let head = content ? ` ${content} ` : "";
    const tail = trailing ? ` ${trailing} ` : "";
    let fill =
      this.renderedWidth - (3 + (trailing ? 1 : 0) + visibleWidth(head) + visibleWidth(tail));
    if (fill < 0) {
      const budget = Math.max(0, visibleWidth(head) + fill - 2);
      head = content ? ` ${truncateToWidth(content, budget, "…")} ` : "";
      fill = 0;
    }
    return (
      this.theme.fg("border", cornerStart + "─") +
      head +
      dash(fill) +
      tail +
      this.theme.fg("border", (trailing ? "─" : "") + cornerEnd)
    );
  }

  private scrollIndicator(above: number, below: number): string | undefined {
    const parts: string[] = [];
    if (above > 0) parts.push(`↑ ${above}`);
    if (below > 0) parts.push(`↓ ${below}`);
    return parts.length ? this.theme.fg("border", `${parts.join(" · ")} more`) : undefined;
  }

  private listEntries(
    runs: readonly AgentInspectorRun[],
    selected: AgentInspectorRun | undefined,
  ): { line: string; selected: boolean }[] {
    if (!runs.length)
      return [{ line: this.theme.fg("muted", "No subagent runs."), selected: false }];
    const entries: { line: string; selected: boolean }[] = [];
    if (!selected)
      entries.push({
        line: this.theme.fg("muted", "Selected run is no longer available."),
        selected: false,
      });
    for (const run of runs) {
      const isSelected = selected?.id === run.id;
      const head = `${run.id} · ${run.agent} · `;
      const tail = ` · ${run.task.replace(/\s+/g, " ")}`;
      const status = `${this.statusIcon(run.status)} ${this.statusText(run.status)}`;
      entries.push({
        line: isSelected
          ? this.theme.fg("accent", `→ ${head}`) + status + this.theme.fg("accent", tail)
          : `  ${head}${status}${tail}`,
        selected: isSelected,
      });
      if (run.text)
        entries.push({
          line: this.theme.fg("dim", `  ${run.text.split("\n").at(-1) ?? ""}`),
          selected: false,
        });
    }
    return entries;
  }

  private detailLines(run: AgentInspectorRun, width: number): string[] {
    const lines: string[] = [];
    if (run.model) lines.push(`${this.theme.fg("muted", "Model:")} ${run.model}`);
    lines.push(`${this.theme.fg("muted", "Thinking:")} ${getSubagentThinkingLabel(run.thinking)}`);
    lines.push(this.theme.fg("muted", "Task:"), ...run.task.split("\n"));
    if (run.activityTruncated) lines.push(this.theme.fg("warning", ACTIVITY_NOTICE));
    const activity = [
      ...run.responses.map((response) => ({
        sequence: response.sequence,
        lines: ["", this.theme.fg("muted", "Response:"), ...response.text.split("\n")],
      })),
      ...run.tools.map((tool) => ({
        sequence: tool.sequence,
        lines: [
          "",
          `• ${this.theme.fg("dim", tool.id)} · ${this.theme.fg("accent", tool.name)} · ${this.statusIcon(tool.status)} ${this.statusText(tool.status)}`,
          `${this.theme.fg("muted", "Args:")} ${tool.args}`,
          ...(tool.output
            ? [
                this.theme.fg("muted", "Output:"),
                ...tool.output.split("\n").map((line) => this.theme.fg("toolOutput", line)),
              ]
            : []),
        ],
      })),
    ].sort((a, b) => a.sequence - b.sequence);
    for (const item of activity) lines.push(...item.lines);
    return wrapLines(lines, width);
  }

  private selectedRun(runs: readonly AgentInspectorRun[]): AgentInspectorRun | undefined {
    if (this.selectedRunId) return runs.find((run) => run.id === this.selectedRunId);
    const selected = runs[this.selectedIndex];
    this.selectedRunId = selected?.id;
    return selected;
  }

  private moveSelection(runs: readonly AgentInspectorRun[], delta: number): void {
    if (!runs.length) return;
    const current = this.selectedRun(runs);
    const index = current ? runs.indexOf(current) : Math.min(this.selectedIndex, runs.length - 1);
    this.selectedIndex = Math.max(0, Math.min(runs.length - 1, index + delta));
    this.selectedRunId = runs[this.selectedIndex]?.id;
  }

  private bodyHeight(): number {
    return Math.max(0, this.overlayHeight() - 2);
  }

  private overlayHeight(): number {
    return Math.max(1, Math.floor(this.tui.terminal.rows * 0.8));
  }
}
