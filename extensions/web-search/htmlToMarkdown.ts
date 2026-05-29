import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "*",
  codeBlockStyle: "fenced",
});

/**
 * Convert an HTML string to Markdown.
 *
 * Pre-processing: strips noise elements (script, style, nav, footer, header,
 * aside, noscript), then extracts <main> or <article> content if present.
 * Then runs Turndown to produce Markdown.
 */
export function htmlToMarkdown(html: string): string {
  // Remove noise elements
  let cleaned = html.replace(
    /<(script|style|nav|footer|header|aside|noscript)[\s\S]*?<\/\1>/gi,
    "",
  );

  // Prefer <main> or <article> content if present
  const mainMatch = cleaned.match(/<(main|article)[\s>][\s\S]*?<\/\1>/i);
  if (mainMatch) cleaned = mainMatch[0];

  const markdown = turndown.turndown(cleaned);

  // Collapse excessive blank lines
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}
