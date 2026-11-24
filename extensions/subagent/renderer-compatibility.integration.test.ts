import { pathToFileURL } from "node:url";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import summaryExtension from "../summary/index.js";
import subagentExtension from "./index.js";

// Route the extensions' SDK imports to the real packages selected for this run.
vi.mock("@earendil-works/pi-coding-agent", async () => {
  const { selectPiSdk } = await import("./test-support/pi-sdk.js");
  return import(pathToFileURL(selectPiSdk().entryPath).href);
});
vi.mock("@earendil-works/pi-tui", async () => {
  const { findPiDependency, selectPiSdk } = await import("./test-support/pi-sdk.js");
  const tuiRoot = findPiDependency(selectPiSdk(), "@earendil-works/pi-tui");
  return import(pathToFileURL(`${tuiRoot}/dist/index.js`).href);
});

import { createEventBus, initTheme } from "@earendil-works/pi-coding-agent";
import type { Box } from "@earendil-works/pi-tui";

initTheme();

type RenderedComponent = Box;
type SubagentRenderer = (
  message: { content: string; details?: unknown },
  options: { expanded: boolean },
  theme: Theme,
) => RenderedComponent;

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("selected Pi SDK renderer compatibility", () => {
  it("[integration] renders the summary entry through its registered callback", () => {
    let renderer:
      | ((
          entry: { data: unknown },
          options: { expanded: boolean },
          theme: Theme,
        ) => RenderedComponent)
      | undefined;
    summaryExtension(
      {
        appendEntry() {},
        on() {
          return () => undefined;
        },
        registerCommand() {},
        registerEntryRenderer(_type, callback) {
          renderer = callback as typeof renderer;
        },
      },
      "/tmp/summary-compatibility.json",
    );

    if (!renderer) throw new Error("The summary entry renderer was not registered");
    const output = renderer(
      {
        data: {
          provider: "openai",
          model: "gpt-6-luna",
          thinking: "medium",
          text: "- **Changes:** Added a renderer compatibility check.",
          usage: { totalTokens: 15 },
        },
      },
      { expanded: false },
      theme,
    )
      .render(80)
      .join("\n");

    expect(output).toContain("[recap]");
    expect(output).toContain("openai/gpt-6-luna");
    expect(output).toContain("Added a renderer compatibility check.");
  });

  it("[integration] renders subagent result and report messages through their registered callbacks", () => {
    const renderers = new Map<string, SubagentRenderer>();
    subagentExtension({
      events: createEventBus(),
      on() {},
      sendMessage() {},
      registerTool() {},
      registerCommand() {},
      registerShortcut() {},
      registerMessageRenderer(customType: string, callback: unknown) {
        renderers.set(customType, callback as SubagentRenderer);
      },
    } as unknown as ExtensionAPI);

    const resultRenderer = renderers.get("subagent-result");
    const reportRenderer = renderers.get("subagent-report");
    if (!resultRenderer || !reportRenderer) {
      throw new Error("The subagent result and report renderers were not registered");
    }
    const result = resultRenderer(
      {
        content: "Agent scout completed.",
        details: {
          runId: "1063e371-3864-4f21-91d9-1e47886f4236",
          results: [
            {
              agent: "scout",
              task: "Check renderer compatibility.",
              preview: "Renderer compatibility check passed.",
              outputPath: "/tmp/renderer-result.md",
              usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
            },
          ],
        },
      },
      { expanded: false },
      theme,
    )
      .render(80)
      .join("\n");
    const report = reportRenderer(
      {
        content: "Agent scout report (run 1063e371):\nDiscovery complete.",
        details: {
          runId: "1063e371-3864-4f21-91d9-1e47886f4236",
          eventId: "1063e371-3864-4f21-91d9-1e47886f4236:1",
          agent: "scout",
        },
      },
      { expanded: false },
      theme,
    )
      .render(80)
      .join("\n");

    expect(result).toContain("scout");
    expect(result).toContain("Renderer compatibility check passed.");
    expect(report).toContain("scout");
    expect(report).toContain("Discovery complete.");
  });
});
