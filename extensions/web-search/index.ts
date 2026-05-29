import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { htmlToMarkdown } from "./htmlToMarkdown.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using DuckDuckGo. Returns a list of results with title, URL, and snippet. Use this when you need to look up information online.",
    promptSnippet: "Search the web for current information",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      max_results: Type.Optional(
        Type.Number({
          description: "Maximum number of results to return (default: 8)",
          default: 8,
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      return webSearch(params.query, params.max_results ?? 8, signal);
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a web page by URL and return its content. For HTML/XHTML pages, converts to Markdown (headings, lists, links, code blocks). For raw files (markdown, text, JSON), returns content as-is. Use this to read the full content of a page found via web_search.",
    promptSnippet: "Fetch and read the full content of a web page by URL",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      max_length: Type.Optional(
        Type.Number({
          description: "Maximum characters to return per chunk (default: 10000)",
          default: 10000,
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description:
            "Character offset to start from (for paginating through long content). Use 0 for the start.",
          default: 0,
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      return webFetch(params.url, params.max_length ?? 10000, params.offset ?? 0, signal);
    },
  });
}

// --- web_search implementation ---

function textResult<TDetails = unknown>(
  text: string,
  details?: TDetails,
): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

async function webSearch(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<AgentToolResult<{ query: string; results: SearchResult[] }>> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    signal,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`Search failed: HTTP ${res.status}`);
  }

  const html = await res.text();
  const results = parseDuckDuckGoResults(html, maxResults);

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
  }>
> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
      redirect: "follow",
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Fetch failed: ${message}`);
  }

  if (!res.ok) {
    throw new Error(`Fetch failed: HTTP ${res.status}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const finalUrl = res.url; // follows redirects

  const fullText = isHtmlContentType(contentType) ? htmlToMarkdown(body) : body;

  const totalLength = fullText.length;
  const chunk = fullText.slice(offset, offset + maxLength);
  const truncated = offset + maxLength < totalLength;

  let output = `URL: ${finalUrl}\n`;
  output += `[Content: ${chunk.length} of ${totalLength} chars, offset ${offset}]\n\n`;
  output += chunk;
  if (truncated) {
    output += `\n\n[truncated — use offset=${offset + maxLength} to continue]`;
  }

  return textResult(output, {
    url: finalUrl,
    offset,
    totalLength,
    chunkLength: chunk.length,
    truncated,
  });
}

function isHtmlContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return lower.includes("text/html") || lower.includes("application/xhtml+xml");
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDuckDuckGoResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DDG HTML wraps each result body in an element with class "result__body"
  const resultBlocks = html.split("result__body").slice(1);

  for (const block of resultBlocks) {
    if (results.length >= max) break;

    // Extract URL and title from <a class="result__a" href="...">Title</a>
    const linkMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    // Extract snippet from <a class="result__snippet" ...>...</a>
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

    if (!linkMatch) continue;

    const rawUrl = linkMatch[1];
    const title = stripHtml(linkMatch[2]).trim();
    const url = decodeRedirectUrl(rawUrl);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : "";

    if (!title || !url) continue;

    results.push({ title, url, snippet });
  }

  return results;
}

/** DDG uses redirect URLs like //duckduckgo.com/l/?uddg=<encoded>&rut=... */
function decodeRedirectUrl(raw: string): string {
  try {
    const full = raw.startsWith("//") ? `https:${raw}` : raw;
    const u = new URL(full);
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return full;
  } catch {
    return raw;
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
