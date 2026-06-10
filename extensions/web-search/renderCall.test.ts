import { describe, expect, it } from "bun:test";
import webSearchExtension from "./index.js";

describe("web-search tool call rendering", () => {
  it("shows the identifying argument for each web-search extension tool", () => {
    const tools: Record<string, any> = {};

    webSearchExtension({
      registerTool(tool: any) {
        tools[tool.name] = tool;
      },
    } as any);

    const theme = {
      bold: (text: string) => text,
      fg: (_color: string, text: string) => text,
    };

    expect(
      tools.web_search.renderCall({ query: "pi coding agent" }, theme, {}).render(80).join("\n"),
    ).toContain("pi coding agent");
    expect(
      tools.web_fetch
        .renderCall({ url: "https://example.com/docs" }, theme, {})
        .render(80)
        .join("\n"),
    ).toContain("https://example.com/docs");
  });
});
