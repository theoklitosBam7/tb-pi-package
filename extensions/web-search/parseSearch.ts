export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

type HtmlNode = {
  tag: string;
  attributes: Record<string, string>;
  children: (HtmlNode | string)[];
};

function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: "", attributes: {}, children: [] };
  const stack = [root];
  const tokens = html.match(/<!--[^]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g) ?? [];

  for (const token of tokens) {
    if (token.startsWith("<!--")) continue;
    if (!token.startsWith("<")) {
      stack[stack.length - 1].children.push(token);
      continue;
    }
    const close = /^<\s*\/\s*([\w:-]+)/.exec(token);
    if (close) {
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index].tag === close[1].toLowerCase()) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const open = /^<\s*([\w:-]+)/.exec(token);
    if (!open) continue;
    const tag = open[1].toLowerCase();
    const attributes: Record<string, string> = {};
    const attrText = token.slice(open[0].length, -1);
    const attrPattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const attr of attrText.matchAll(attrPattern)) {
      attributes[attr[1].toLowerCase()] = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? "");
    }
    const node: HtmlNode = { tag, attributes, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!token.endsWith("/>") && !["br", "hr", "img", "input", "meta", "link"].includes(tag)) {
      stack.push(node);
    }
  }
  return root;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    copy: "©",
    reg: "®",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
    eacute: "é",
    trade: "™",
    bull: "•",
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (entity, code: string) => {
    if (code.startsWith("#")) {
      const hex = code[1]?.toLowerCase() === "x";
      const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function hasClass(node: HtmlNode, name: string): boolean {
  return node.attributes.class?.split(/\s+/).includes(name) ?? false;
}

function collect(root: HtmlNode, predicate: (node: HtmlNode) => boolean): HtmlNode[] {
  const found: HtmlNode[] = [];
  for (const child of root.children) {
    if (typeof child === "string") continue;
    if (predicate(child)) found.push(child);
    found.push(...collect(child, predicate));
  }
  return found;
}

function normalizedNodeText(node: HtmlNode): string {
  return rawText(node).replace(/\s+/g, " ").trim();
}

function rawText(node: HtmlNode): string {
  return node.children
    .map((child) => (typeof child === "string" ? decodeEntities(child) : rawText(child)))
    .join("");
}

function resultUrl(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const full = href.startsWith("//") ? `https:${href}` : href;
  try {
    const parsed = new URL(full);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (parsed.hostname === "duckduckgo.com" && parsed.pathname === "/l/") {
      const target = parsed.searchParams.get("uddg");
      if (target !== null) {
        const destination = new URL(target);
        return destination.protocol === "http:" || destination.protocol === "https:"
          ? target
          : undefined;
      }
    }
    return full;
  } catch {
    return undefined;
  }
}

function makeResult(link: HtmlNode, snippet?: HtmlNode): SearchResult | undefined {
  const title = normalizedNodeText(link);
  const url = resultUrl(link.attributes.href);
  if (!title || !url) return undefined;
  return { title, url, snippet: snippet ? normalizedNodeText(snippet) : "" };
}

export function parseDuckDuckGoResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  for (const body of collect(parseHtml(html), (node) => hasClass(node, "result__body"))) {
    if (results.length >= max) break;
    const link = collect(body, (node) => node.tag === "a" && hasClass(node, "result__a"))[0];
    if (!link) continue;
    const snippet = collect(body, (node) => hasClass(node, "result__snippet"))[0];
    const result = makeResult(link, snippet);
    if (result) results.push(result);
  }
  return results;
}

export function parseLiteResults(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  let pending: SearchResult | undefined;
  for (const row of collect(parseHtml(html), (node) => node.tag === "tr")) {
    const link = collect(row, (node) => node.tag === "a" && hasClass(node, "result-link"))[0];
    if (link) {
      if (pending) results.push(pending);
      if (results.length >= max) return results;
      pending = makeResult(link);
    }
    const snippet = collect(row, (node) => hasClass(node, "result-snippet"))[0];
    if (pending && snippet) pending.snippet = normalizedNodeText(snippet);
  }
  if (pending && results.length < max) results.push(pending);
  return results;
}
