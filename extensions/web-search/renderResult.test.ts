import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import webSearchExtension from "./index.js";

initTheme();

function registerTools() {
  const tools: Record<string, any> = {};
  webSearchExtension({
    registerTool(tool: any) {
      tools[tool.name] = tool;
    },
  } as any);
  return tools;
}

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

function renderResult(
  tool: any,
  result: unknown,
  options: { expanded: boolean; isPartial?: boolean },
) {
  return tool
    .renderResult(result, { isPartial: false, ...options }, theme, {})
    .render(80)
    .join("\n");
}

describe("web-search tool result rendering", () => {
  it("collapses web_search to a summary with an expand hint", () => {
    const tools = registerTools();
    const result = {
      content: [
        {
          type: "text",
          text: "1. First Result\n   https://example.com/1\n   snippet one\n\n2. Second Result\n   https://example.com/2\n   snippet two",
        },
      ],
      details: {
        query: "pi coding agent",
        results: [
          { title: "First Result", url: "https://example.com/1", snippet: "snippet one" },
          { title: "Second Result", url: "https://example.com/2", snippet: "snippet two" },
        ],
      },
    };

    const output = renderResult(tools.web_search, result, { expanded: false });

    expect(output).toContain("2 results");
    expect(output).toContain("to expand");
    expect(output).not.toContain("snippet one");
    expect(output).not.toContain("https://example.com/1");
  });

  it("shows full web_search content when expanded", () => {
    const tools = registerTools();
    const result = {
      content: [
        {
          type: "text",
          text: "1. First Result\n   https://example.com/1\n   snippet one\n\n2. Second Result\n   https://example.com/2\n   snippet two",
        },
      ],
      details: {
        query: "pi coding agent",
        results: [
          { title: "First Result", url: "https://example.com/1", snippet: "snippet one" },
          { title: "Second Result", url: "https://example.com/2", snippet: "snippet two" },
        ],
      },
    };

    const output = renderResult(tools.web_search, result, { expanded: true });

    expect(output).toContain("snippet one");
    expect(output).toContain("https://example.com/2");
    expect(output).toContain("Second Result");
    expect(output).not.toContain("to expand");
  });

  it("collapses empty web_search results without throwing", () => {
    const tools = registerTools();
    const result = {
      content: [{ type: "text", text: "No results found." }],
      details: { query: "zzzz-no-match", results: [] },
    };

    const output = renderResult(tools.web_search, result, { expanded: false });

    expect(output).toMatch(/No results found\.|0 results/);
    expect(output).toContain("to expand");
  });

  it("collapses web_fetch to a metadata summary with an expand hint", () => {
    const tools = registerTools();
    const result = {
      content: [
        {
          type: "text",
          text: "URL: https://example.com/docs\n[Content: 120 of 5000 chars, offset 0]\n\n# Docs\n\nLots of body text here that should stay hidden.",
        },
      ],
      details: {
        url: "https://example.com/docs",
        offset: 0,
        totalLength: 5000,
        chunkLength: 120,
        truncated: true,
      },
    };

    const output = renderResult(tools.web_fetch, result, { expanded: false });

    expect(output).toContain("https://example.com/docs");
    expect(output).toContain("120");
    expect(output).toContain("5000");
    expect(output).toContain("to expand");
    expect(output).not.toContain("Lots of body text here that should stay hidden.");
  });

  it("shows full web_fetch content when expanded", () => {
    const tools = registerTools();
    const result = {
      content: [
        {
          type: "text",
          text: "URL: https://example.com/docs\n[Content: 120 of 5000 chars, offset 0]\n\n# Docs\n\nLots of body text here that should stay hidden.",
        },
      ],
      details: {
        url: "https://example.com/docs",
        offset: 0,
        totalLength: 5000,
        chunkLength: 120,
        truncated: true,
      },
    };

    const output = renderResult(tools.web_fetch, result, { expanded: true });

    expect(output).toContain("Lots of body text here that should stay hidden.");
    expect(output).not.toContain("to expand");
  });

  it("falls back when web_fetch details are missing", () => {
    const tools = registerTools();
    const result = {
      content: [{ type: "text", text: "URL: https://example.com/fallback\n\nbody" }],
    };

    const output = renderResult(tools.web_fetch, result, { expanded: false });

    expect(output).toContain("https://example.com/fallback");
    expect(output).toContain("to expand");
    expect(output).not.toContain("\nbody");
  });
});
