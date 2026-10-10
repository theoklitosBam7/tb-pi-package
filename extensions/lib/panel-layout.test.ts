import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Image,
  KeybindingsManager,
  setCapabilities,
  resetCapabilitiesCache,
  Text,
  TUI_KEYBINDINGS,
  TuiMainScreen,
  type Component,
  type Terminal,
  type TUI,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import askUser, { AskUserParameters, type AskUserDetails } from "../ask-user/index.js";
import subagent from "../subagent/index.js";

type AskUserTool = ToolDefinition<typeof AskUserParameters, AskUserDetails>;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} satisfies Pick<Theme, "fg" | "bg" | "bold">;
type Custom = ExtensionContext["ui"]["custom"];
type CustomFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: Parameters<Parameters<Custom>[0]>[2],
  done: (result: T) => void,
) => ReturnType<Parameters<Custom>[0]>;
afterEach(() => resetCapabilitiesCache());

function panelHarness() {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  const terminal: Terminal = {
    rows: 24,
    columns: 80,
    kittyProtocolActive: false,
    start: vi.fn(),
    stop: vi.fn(),
    drainInput: async () => {},
    write: vi.fn(),
    moveBy: vi.fn(),
    hideCursor: vi.fn(),
    showCursor: vi.fn(),
    clearLine: vi.fn(),
    clearFromCursor: vi.fn(),
    clearScreen: vi.fn(),
    setTitle: vi.fn(),
    setProgress: vi.fn(),
    setProgramStatus: vi.fn(),
  };
  const tui = new TuiMainScreen(terminal);
  const transcript = new Container();
  const editor = new Container();
  const input = new Text("Main input", 0, 0);
  editor.addChild(input);
  tui.addChild(transcript);
  tui.addChild(editor);
  let panel: Component | undefined;
  const addImage = () => {
    transcript.addChild(
      new Image(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "image/png",
        { fallbackColor: (text) => text },
        { maxWidthCells: 30, maxHeightCells: 16 },
        { widthPx: 300, heightPx: 320 },
      ),
    );
    tui.renderNow(true);
  };
  const custom: Custom = <T>(factory: CustomFactory<T>, options?: Parameters<Custom>[1]) =>
    new Promise<T>((resolve, reject) => {
      const done = (result: T) => {
        if (options?.overlay) tui.hideOverlay();
        else {
          editor.clear();
          editor.addChild(input);
          tui.setFocus(input);
        }
        tui.renderNow(true);
        resolve(result);
      };
      // The host fixture supplies only the theme and keybinding methods these panels use.
      const created: ReturnType<CustomFactory<T>> = Reflect.apply(factory, undefined, [
        tui,
        theme,
        new KeybindingsManager(TUI_KEYBINDINGS),
        done,
      ]);
      Promise.resolve(created).then((component) => {
        panel = component;
        if (options?.overlay) {
          const layout = options.overlayOptions;
          tui.showOverlay(component, typeof layout === "function" ? layout() : layout);
        } else {
          editor.clear();
          editor.addChild(component);
          tui.setFocus(component);
        }
        tui.renderNow(true);
      }, reject);
    });
  const assertSeparateRows = (marker: string) => {
    const lines = tui.captureRenderState().previousLines;
    const panelRow = lines.findIndex((line) => line.includes(marker));
    expect(panelRow, `panel text ${marker} must be rendered`).toBeGreaterThanOrEqual(0);
    expect(lines.some((line) => line.includes("\x1b_G"))).toBe(true);
    const panelRows = lines.flatMap((line, row) => (/^[┌│└]/.test(line) ? [row] : []));
    expect(panelRows.length).toBeGreaterThan(0);
    for (const [row, line] of lines.entries()) {
      if (!line.includes("\x1b_G")) continue;
      const header = line.split(";")[0] ?? "";
      const imageRows = /(?:^|,)r=(\d+)(?:,|$)/.exec(header)?.[1];
      if (imageRows) {
        for (const panelRow of panelRows) {
          expect(
            panelRow < row || panelRow >= row + Number(imageRows),
            `Panel row ${panelRow} overlaps image rows ${row}..${row + Number(imageRows) - 1}`,
          ).toBe(true);
        }
      }
    }
  };
  return {
    addImage,
    custom,
    assertSeparateRows,
    close() {
      if (!panel) throw new Error("Panel was not opened");
      panel.handleInput?.("\x1b");
      expect(tui.captureRenderState().previousLines.join("\n")).toContain("Main input");
    },
  };
}

describe("panel image layout", () => {
  it("keeps question text outside existing and newly received image rows", async () => {
    const harness = panelHarness();
    let tool: AskUserTool | undefined;
    Reflect.apply(askUser, undefined, [
      {
        registerTool(definition: AskUserTool) {
          tool = definition;
        },
      },
    ]);
    if (!tool) throw new Error("ask_user was not registered");
    harness.addImage();
    const execution = Reflect.apply(tool.execute, tool, [
      "image-layout",
      {
        questions: [
          { id: "release", question: "Choose a release?", options: [{ label: "Stable" }] },
        ],
      },
      undefined,
      undefined,
      { mode: "tui", hasUI: true, ui: { custom: harness.custom } },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    harness.assertSeparateRows("Choose a release?");
    harness.addImage();
    harness.assertSeparateRows("Choose a release?");
    harness.close();
    await execution;
  });

  it("keeps inspector text outside existing and newly received image rows", async () => {
    const harness = panelHarness();
    let command: Command | undefined;
    Reflect.apply(subagent, undefined, [
      {
        on() {},
        registerTool() {},
        registerShortcut() {},
        registerCommand(name: string, definition: Command) {
          if (name === "agent-inspector") command = definition;
        },
      },
    ]);
    if (!command) throw new Error("agent-inspector was not registered");
    harness.addImage();
    const execution = Reflect.apply(command.handler, command, [
      "",
      {
        mode: "tui",
        ui: { custom: harness.custom },
      },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    harness.assertSeparateRows("Subagent runs");
    harness.addImage();
    harness.assertSeparateRows("Subagent runs");
    harness.close();
    await execution;
  });
});
