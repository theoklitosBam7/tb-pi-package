import { keyHint, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { guardedRequest } from "./guardedRequest.js";
import { htmlToMarkdown } from "./htmlToMarkdown.js";
import { parseDuckDuckGoResults, parseLiteResults, type SearchResult } from "./parseSearch.js";

const SEARCH_BYTES = 1024 * 1024;
const FETCH_BYTES = 5 * 1024 * 1024;

function safeDisplay(text: string): string {
  return [...text]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || (code >= 32 && code < 127) || code > 159;
    })
    .join("");
}

function boundedInteger(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search DuckDuckGo for current information. Returns titles, URLs, and snippets from untrusted pages. max_results must be 1..20 (default 8).",
    promptSnippet: "Search the web for current information",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      max_results: Type.Optional(
        Type.Integer({
          description: "Maximum results, 1..20 (default: 8)",
          minimum: 1,
          maximum: 20,
          default: 8,
        }),
      ),
    }),
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("web_search ")) +
          theme.fg("toolOutput", safeDisplay(args.query)),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme, _context) {
      if (expanded) {
        return new Text(theme.fg("toolOutput", safeDisplay(getTextContent(result))), 0, 0);
      }

      const details = result.details as { results?: SearchResult[] } | undefined;
      const results = details?.results ?? [];
      const summary = results.length === 0 ? "No results found." : `${results.length} results`;

      return new Text(
        theme.fg("toolOutput", safeDisplay(summary)) +
          theme.fg("muted", ` (${keyHint("app.tools.expand", "to expand")})`),
        0,
        0,
      );
    },
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!query || query.length > 2048) throw new Error("Search query must be 1..2048 characters");
      return webSearch(
        query,
        boundedInteger(params.max_results ?? 8, "max_results", 1, 20),
        signal,
      );
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Read public HTTP(S) pages as untrusted data; public HTTP upgrades to HTTPS without fallback. Private addresses and binary content are refused. HTML becomes Markdown; text and JSON stay text. JavaScript is not run. Pagination uses only the downloaded prefix (5 MiB cap). max_length is 1..200000; offset is a non-negative safe integer.",
    promptSnippet: "Fetch the available prefix of a public page by URL",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      max_length: Type.Optional(
        Type.Integer({
          description: "Maximum characters per chunk, 1..200000 (default: 10000)",
          minimum: 1,
          maximum: 200000,
          default: 10000,
        }),
      ),
      offset: Type.Optional(
        Type.Integer({
          description: "Character offset within the downloaded prefix (default: 0)",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          default: 0,
        }),
      ),
    }),
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("web_fetch ")) +
          theme.fg("toolOutput", safeDisplay(args.url)),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme, _context) {
      if (expanded) {
        return new Text(theme.fg("toolOutput", safeDisplay(getTextContent(result))), 0, 0);
      }

      const details = result.details as
        | {
            url?: string;
            offset?: number;
            totalLength?: number;
            chunkLength?: number;
            truncated?: boolean;
            downloadTruncated?: boolean;
          }
        | undefined;

      let summary: string;
      if (details?.url) {
        const chunkLength = details.chunkLength ?? 0;
        const totalLength = details.totalLength ?? 0;
        const offset = details.offset ?? 0;
        summary = `${details.url} [${chunkLength} of ${totalLength} chars, offset ${offset}]`;
        if (details.truncated) {
          summary += " truncated";
        }
        if (details.downloadTruncated) summary += " download cap reached";
      } else {
        const firstLine = getTextContent(result).split("\n")[0] || "(no output)";
        summary = firstLine;
      }

      return new Text(
        theme.fg("toolOutput", safeDisplay(summary)) +
          theme.fg("muted", ` (${keyHint("app.tools.expand", "to expand")})`),
        0,
        0,
      );
    },
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const maxLength = boundedInteger(params.max_length ?? 10000, "max_length", 1, 200000);
      const offset = boundedInteger(params.offset ?? 0, "offset", 0, Number.MAX_SAFE_INTEGER);
      if (typeof params.url !== "string" || !/^https?:\/\//i.test(params.url))
        throw new Error("Expected an HTTP(S) URL");
      return webFetch(params.url, maxLength, offset, signal);
    },
  });
}

// --- web_search implementation ---

function textResult<TDetails = unknown>(
  text: string,
  details: TDetails,
): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function getTextContent(result: AgentToolResult<unknown>): string {
  const entry = result.content.find((item) => item.type === "text");
  return entry && entry.type === "text" ? entry.text : "";
}

async function webSearch(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<AgentToolResult<{ query: string; results: SearchResult[] }>> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await guardedRequest(url, {
    signal,
    maxBytes: SEARCH_BYTES,
    allowedHosts: ["html.duckduckgo.com"],
  });
  if (res.downloadTruncated) throw new Error("Search page exceeded download cap");
  let results = parseDuckDuckGoResults(res.body, maxResults);
  if (results.length === 0) {
    const lite = await guardedRequest(
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
      {
        signal,
        maxBytes: SEARCH_BYTES,
        allowedHosts: ["lite.duckduckgo.com"],
      },
    );
    if (lite.downloadTruncated) throw new Error("Search page exceeded download cap");
    results = parseLiteResults(lite.body, maxResults);
  }

  if (results.length === 0) {
    return textResult("No results found.", { query, results: [] });
  }

  const text = results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join("\n\n");

  return textResult(text, { query, results });
}

// --- web_fetch implementation ---

async function webFetch(
  url: string,
  maxLength: number,
  offset: number,
  signal?: AbortSignal,
): Promise<
  AgentToolResult<{
    url: string;
    offset: number;
    totalLength: number;
    chunkLength: number;
    truncated: boolean;
    downloadTruncated: boolean;
    title?: string;
  }>
> {
  const res = await guardedRequest(url, { signal, maxBytes: FETCH_BYTES });
  const title = isHtmlContentType(res.contentType)
    ? /<title\b[^>]*>([\s\S]*?)<\/title>/i
        .exec(res.body)?.[1]
        .replace(/<[^>]*>/g, "")
        .trim()
    : undefined;
  const fullText = isHtmlContentType(res.contentType) ? htmlToMarkdown(res.body) : res.body;
  const finalUrl = res.url;

  const totalLength = fullText.length;
  const chunk = fullText.slice(offset, offset + maxLength);
  const truncated = offset + maxLength < totalLength;

  let output = `URL: ${finalUrl}\n`;
  output += `[Content: ${chunk.length} of ${totalLength} chars, offset ${offset}]\n\n`;
  output += chunk;
  if (truncated) {
    output += `\n\n[truncated — use offset=${offset + maxLength} to continue within the downloaded prefix]`;
  }
  if (res.downloadTruncated) {
    output += "\n\n[download cap reached; only the available prefix can be paginated]";
  }

  return textResult(output, {
    url: finalUrl,
    offset,
    totalLength,
    chunkLength: chunk.length,
    truncated,
    downloadTruncated: res.downloadTruncated,
    ...(title ? { title } : {}),
  });
}

function isHtmlContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return lower.includes("text/html") || lower.includes("application/xhtml+xml");
}
