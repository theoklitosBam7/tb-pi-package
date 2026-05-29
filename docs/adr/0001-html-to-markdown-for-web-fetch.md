# Use Turndown for HTML-to-Markdown conversion in web_fetch

The `web_fetch` tool converts HTML and XHTML pages to Markdown for LLM consumption. We decided to switch from regex-based HTML stripping to Markdown output via `turndown`, preserving document structure (headings, lists, links, code blocks) that the agent needs to reason about fetched content effectively.

This is the package's first runtime dependency. We considered writing a custom converter to stay zero-dep, but HTML parsing is a deep rabbit hole and Turndown is the de-facto standard. Content extraction (strip script/style/nav/footer/header/aside, prefer first `<main>` or `<article>`) is kept as a pre-processing step before Turndown runs. GFM plugin is not included — standard Turndown defaults are sufficient.

**Security:** Regex-based element stripping is best-effort only (e.g. malformed or nested tags can leak content). Fetched pages are untrusted; agents must treat output as hostile input, not sanitized HTML.
