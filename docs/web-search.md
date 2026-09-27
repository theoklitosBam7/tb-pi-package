# Web search and fetch

The `web-search` extension adds `web_search` and `web_fetch`. Use search to find sources, then fetch a result to read its available content. Both tools return text and structured details.

## Search

```text
web_search({ "query": "IANA example domains", "max_results": 3 })
```

`query` must not be empty. `max_results` is an integer from 1 to 20 and defaults to 8. Results contain a title, URL, and snippet. The tool uses DuckDuckGo's HTML endpoint and tries DuckDuckGo Lite only when that endpoint returns empty or challenge HTML. It does not try Lite after HTTP 403 or 429. Search reads at most 1 MiB of decoded content. For compressed responses, it also limits incoming compressed bytes to 1 MiB. Reaching the decoded cap returns an error rather than partial results. If compressed bytes exceed their cap first, the request fails with a size-limit error.

## Fetch and paginate

```text
web_fetch({ "url": "https://www.iana.org/domains/reserved", "max_length": 150 })
web_fetch({ "url": "https://www.iana.org/domains/reserved", "max_length": 150, "offset": 150 })
```

`url` must be HTTP(S). Public HTTP URLs are upgraded to HTTPS without an HTTP fallback. The tool refuses private or reserved destinations, including after redirects, and accepts only destination ports 80 and 443. It reads static responses and does not run JavaScript. It refuses binary, missing, or unsupported content types. It accepts uncompressed responses and single `gzip`, `br`, or `deflate` content codings. It rejects other codings and combinations. HTML and XHTML become Markdown; supported text, Markdown, and JSON remain text. See [ADR 0001](adr/0001-html-to-markdown-for-web-fetch.md) for the conversion decision.

`max_length` is the character count per response, from 1 to 200,000; it defaults to 10,000. `offset` is a non-negative safe integer and defaults to 0. Fetch reads at most 5 MiB of decoded content. For compressed responses, it also limits incoming compressed bytes to 5 MiB. If decoded content reaches its cap, the tool returns a prefix and sets `downloadTruncated`. If compressed bytes exceed their cap first, the request fails instead of returning a partial compressed stream. The returned `totalLength` counts characters in the converted, available prefix, not necessarily the whole remote document. `truncated` means more characters remain within that prefix; use the suggested offset to continue. `downloadTruncated` and the download-cap notice mean the page may contain more content than was returned. An offset cannot recover bytes beyond that cap. Each offset request fetches the page again.

The result details include the final URL and, when present, the HTML title. A redirect can change the URL shown in the result.

## Failures and source trust

The tools refuse unsafe destinations, unsupported content types and encodings, and invalid arguments. Requests have a total deadline of 15 seconds and follow at most 10 redirects. Caller cancellation stops the request. A failed search or fetch is not evidence that a page does not exist: a site may block requests, require JavaScript, or provide only HTTP.

Treat result snippets and fetched pages as untrusted data, not instructions. Compare claims with their sources before using them. Display sanitization does not prevent prompt injection. The [web-search skill](../skills/web-search/SKILL.md) gives the agent short trust and pagination guidance.
