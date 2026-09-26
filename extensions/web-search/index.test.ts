import { describe, expect, it, vi } from "vitest";
import extension from "./index.js";
import { guardedRequest } from "./guardedRequest.js";

vi.mock("./guardedRequest.js", () => ({ guardedRequest: vi.fn() }));

function tools() {
  const registered: Record<string, any> = {};
  extension({
    registerTool(tool: any) {
      registered[tool.name] = tool;
    },
  } as any);
  return registered;
}

async function run(tool: any, params: Record<string, unknown>, signal?: AbortSignal) {
  return tool.execute("test", params, signal, undefined, {});
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
    expect((await run(tools().web_search, { query: "none" })).content[0].text).toBe(
      "No results found.",
    );
    expect(guardedRequest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(guardedRequest).mock.calls[1][1].allowedHosts).toEqual([
      "lite.duckduckgo.com",
    ]);
    vi.mocked(guardedRequest).mockReset().mockRejectedValueOnce(new Error("HTTP 429"));
    await expect(run(tools().web_search, { query: "rate limit" })).rejects.toThrow("HTTP 429");
    expect(guardedRequest).toHaveBeenCalledTimes(1);
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
    expect(result.content[0].text).toContain("Body");
    expect(result.content[0].text).not.toContain("# Page title");
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
    expect(result.content[0].text).toContain("download cap");
    expect(result.content[0].text).not.toContain("offset=6 to continue");
  });
});
