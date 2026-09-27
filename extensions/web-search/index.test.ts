import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import extension from "./index.js";
import { guardedRequest } from "./guardedRequest.js";

vi.mock("./guardedRequest.js", () => ({ guardedRequest: vi.fn() }));

type RegisteredTool = Pick<ToolDefinition, "execute">;

function tools(): Record<string, RegisteredTool> {
  const registered: Record<string, RegisteredTool> = {};
  extension({
    registerTool(tool) {
      registered[tool.name] = tool;
    },
  });
  return registered;
}

async function run(
  tool: RegisteredTool,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
  // The registered tools do not use ctx. Call with the arguments under test, then check the result.
  const result: unknown = await Reflect.apply(tool.execute, undefined, ["test", params, signal]);
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content) ||
    !result.content.every(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )
  ) {
    throw new Error("Expected text tool result");
  }
  return { content: result.content, details: "details" in result ? result.details : undefined };
}

function resultText(result: AgentToolResult<unknown>): string {
  const content = result.content[0];
  if (!content || content.type !== "text") throw new Error("Expected text result");
  return content.text;
}

describe("web-search tool execution", () => {
  it("rejects invalid arguments before sending a request", async () => {
    vi.mocked(guardedRequest).mockClear();
    const { web_search, web_fetch } = tools();
    for (const value of [0, -1, 1.5, 21, NaN, Infinity]) {
      await expect(run(web_search, { query: "test", max_results: value })).rejects.toThrow();
    }
    for (const value of [0, -1, 1.5, 200001, NaN, Infinity]) {
      await expect(
        run(web_fetch, { url: "https://example.com", max_length: value }),
      ).rejects.toThrow();
    }
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(run(web_fetch, { url: "https://example.com", offset: value })).rejects.toThrow();
    }
    await expect(run(web_search, { query: "  " })).rejects.toThrow();
    await expect(run(web_fetch, { url: "file:///etc/passwd" })).rejects.toThrow();
    expect(guardedRequest).not.toHaveBeenCalled();
  });

  it("keeps search defaults and structured results", async () => {
    vi.mocked(guardedRequest).mockResolvedValueOnce({
      url: "https://html.duckduckgo.com/html/",
      status: 200,
      contentType: "text/html",
      body: '<div class="result__body"><a class="result__a" href="https://example.com/">Example</a><a class="result__snippet">A result</a></div>',
      downloadTruncated: false,
    });
    const result = await run(tools().web_search, { query: "  example " });
    expect(guardedRequest).toHaveBeenCalledWith(
      expect.stringContaining("q=example"),
      expect.objectContaining({ maxBytes: 1048576, allowedHosts: ["html.duckduckgo.com"] }),
    );
    expect(result.details).toEqual({
      query: "example",
      results: [{ title: "Example", url: "https://example.com/", snippet: "A result" }],
    });
  });

  it("tries Lite for empty HTML but not for an HTTP 429", async () => {
    vi.mocked(guardedRequest).mockReset();
    vi.mocked(guardedRequest)
      .mockResolvedValueOnce({
        url: "https://html.duckduckgo.com/html/",
        status: 200,
        contentType: "text/html",
        body: "<html></html>",
        downloadTruncated: false,
      })
      .mockResolvedValueOnce({
        url: "https://lite.duckduckgo.com/lite/",
        status: 200,
        contentType: "text/html",
        body: "<html></html>",
        downloadTruncated: false,
      });
    expect(resultText(await run(tools().web_search, { query: "none" }))).toBe("No results found.");
    expect(guardedRequest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(guardedRequest).mock.calls[1][1].allowedHosts).toEqual([
      "lite.duckduckgo.com",
    ]);
    vi.mocked(guardedRequest).mockReset().mockRejectedValueOnce(new Error("HTTP 429"));
    await expect(run(tools().web_search, { query: "rate limit" })).rejects.toThrow("HTTP 429");
    expect(guardedRequest).toHaveBeenCalledTimes(1);
  });

  it("tries Lite for a challenge page", async () => {
    vi.mocked(guardedRequest)
      .mockReset()
      .mockResolvedValueOnce({
        url: "https://html.duckduckgo.com/html/",
        status: 200,
        contentType: "text/html",
        body: "<html><body>Please complete the CAPTCHA challenge.</body></html>",
        downloadTruncated: false,
      })
      .mockResolvedValueOnce({
        url: "https://lite.duckduckgo.com/lite/",
        status: 200,
        contentType: "text/html",
        body: '<tr><td><a class="result-link" href="https://example.com/">Example</a></td></tr>',
        downloadTruncated: false,
      });
    const result = await run(tools().web_search, { query: "example" });
    expect(result.details).toMatchObject({
      results: [{ title: "Example", url: "https://example.com/", snippet: "" }],
    });
  });

  it("does not try Lite for non-HTML or ordinary no-results HTML", async () => {
    for (const response of [
      { contentType: "application/json", body: '{"error":"unavailable"}' },
      { contentType: "text/html", body: "<html><body>No results found.</body></html>" },
    ]) {
      vi.mocked(guardedRequest)
        .mockReset()
        .mockResolvedValueOnce({
          url: "https://html.duckduckgo.com/html/",
          status: 200,
          ...response,
          downloadTruncated: false,
        });
      const result = await run(tools().web_search, { query: "not found" });
      expect(resultText(result)).toBe("No results found.");
      expect(guardedRequest).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps cancellation and Lite failure distinct from empty results", async () => {
    vi.mocked(guardedRequest)
      .mockReset()
      .mockResolvedValueOnce({
        url: "https://html.duckduckgo.com/html/",
        status: 200,
        contentType: "text/html",
        body: "",
        downloadTruncated: false,
      })
      .mockRejectedValueOnce(Object.assign(new Error("Request cancelled"), { name: "AbortError" }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      run(tools().web_search, { query: "test" }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.mocked(guardedRequest).mock.calls[1][1].signal).toBe(controller.signal);
  });

  it("returns the HTML title in details without adding a heading", async () => {
    vi.mocked(guardedRequest).mockReset().mockResolvedValueOnce({
      url: "https://example.com/final",
      status: 200,
      contentType: "text/html",
      body: "<html><head><title>Page title</title></head><body><p>Body</p></body></html>",
      downloadTruncated: false,
    });
    const result = await run(tools().web_fetch, { url: "https://example.com/start" });
    expect(result.details).toMatchObject({ title: "Page title", url: "https://example.com/final" });
    expect(resultText(result)).toContain("Body");
    expect(resultText(result)).not.toContain("# Page title");
  });

  it("paginates only within the downloaded prefix and identifies the cap", async () => {
    vi.mocked(guardedRequest).mockReset().mockResolvedValue({
      url: "https://example.com/page",
      status: 200,
      contentType: "text/plain",
      body: "abcdef",
      downloadTruncated: true,
    });
    const result = await run(tools().web_fetch, {
      url: "https://example.com/page",
      max_length: 2,
      offset: 4,
    });
    expect(result.details).toMatchObject({
      url: "https://example.com/page",
      totalLength: 6,
      offset: 4,
      chunkLength: 2,
      truncated: false,
      downloadTruncated: true,
    });
    expect(resultText(result)).toContain("download cap");
    expect(resultText(result)).not.toContain("offset=6 to continue");
  });
});
