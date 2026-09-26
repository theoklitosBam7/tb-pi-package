import { describe, expect, it } from "vitest";
import { parseDuckDuckGoResults, parseLiteResults } from "./parseSearch.js";

describe("parseDuckDuckGoResults", () => {
  it("returns a result with its own title, URL, and snippet", () => {
    const html = `
      <div class="result__body">
        <h2><a class="result__a" href="https://example.com/first">First result</a></h2>
        <a class="result__snippet">First snippet</a>
      </div>
      <div class="result__body">
        <h2><a class="result__a" href="https://example.com/second">Second result</a></h2>
        <a class="result__snippet">Second snippet</a>
      </div>`;

    expect(parseDuckDuckGoResults(html, 2)).toEqual([
      { title: "First result", url: "https://example.com/first", snippet: "First snippet" },
      { title: "Second result", url: "https://example.com/second", snippet: "Second snippet" },
    ]);
  });

  it("accepts mixed attribute order, quotes, extra classes, and nested text with entities", () => {
    const html = `
      <div id='one' class='other result__body featured'>
        <h2><a href='https://example.com/?a=1&amp;b=2' rel='nofollow' class='highlight result__a'>
          A <b>bold &amp; bright</b> &#x1F680; result
        </a></h2>
        <a href='#' class='extra result__snippet'>A <b>nested</b> &quot;snippet&quot; &#39;yes&#39;</a>
      </div>`;

    expect(parseDuckDuckGoResults(html, 2)).toEqual([
      {
        title: "A bold & bright 🚀 result",
        url: "https://example.com/?a=1&b=2",
        snippet: "A nested \"snippet\" 'yes'",
      },
    ]);
  });

  it("preserves spaces around nested text and decodes common named entities", () => {
    const html = `<div class="result__body">
      <a class="result__a" href="https://example.com">The <b>caf&eacute; </b>is open</a>
      <a class="result__snippet">It&rsquo;s <em>very </em>good&nbsp;today</a>
    </div>`;

    expect(parseDuckDuckGoResults(html, 1)).toEqual([
      { title: "The café is open", url: "https://example.com", snippet: "It’s very good today" },
    ]);
  });

  it("keeps snippets within their result even when the first snippet is missing", () => {
    const html = `
      <div class="result__body"><a class="result__a" href="https://example.com/first">First</a></div>
      <div class="result__body"><a class="result__a" href="https://example.com/second">Second</a>
        <a class="result__snippet">Second's snippet</a></div>`;

    expect(parseDuckDuckGoResults(html, 2)).toEqual([
      { title: "First", url: "https://example.com/first", snippet: "" },
      { title: "Second", url: "https://example.com/second", snippet: "Second's snippet" },
    ]);
  });

  it("unwraps only DDG /l/ redirects once and keeps encoded percent sequences", () => {
    const html = `
      <div class='result__body'><a class='result__a' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fsearch%3Fq%3D%252F&amp;rut=abc'>DDG</a></div>
      <div class='result__body'><a class='result__a' href='https://example.com/l/?uddg=https%3A%2F%2Fevil.test%2F'>Direct</a></div>
      <div class='result__body'><a class='result__a' href='https://duckduckgo.com/other/?uddg=https%3A%2F%2Fevil.test%2F'>Other path</a></div>`;

    expect(parseDuckDuckGoResults(html, 3)).toEqual([
      { title: "DDG", url: "https://example.com/search?q=%2F", snippet: "" },
      {
        title: "Direct",
        url: "https://example.com/l/?uddg=https%3A%2F%2Fevil.test%2F",
        snippet: "",
      },
      {
        title: "Other path",
        url: "https://duckduckgo.com/other/?uddg=https%3A%2F%2Fevil.test%2F",
        snippet: "",
      },
    ]);
  });

  it("does not decode a redirect target or an entity a second time", () => {
    const html = `
      <div class='result__body'>
        <a class='result__a' href='https://duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fl%2F%3Fuddg%3Dhttps%253A%252F%252Fexample.com'>A &amp;lt; B</a>
        <a class='result__snippet'>A &amp;amp; B</a>
      </div>`;

    expect(parseDuckDuckGoResults(html, 1)).toEqual([
      {
        title: "A &lt; B",
        url: "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com",
        snippet: "A &amp; B",
      },
    ]);
  });

  it("skips invalid or non-http links without using up the result limit", () => {
    const html = `
      <div class='result__body'><a class='result__a' href='javascript:alert(1)'>Script</a></div>
      <div class='result__body'><a class='result__a' href='https://duckduckgo.com/l/?uddg=ftp%3A%2F%2Fexample.com'>FTP</a></div>
      <div class='result__body'><a class='result__a' href='https://duckduckgo.com/l/?uddg=not-a-url'>Bad redirect</a></div>
      <div class='result__body'><a class='result__a' href='https://example.com/ok'>Valid</a></div>
      <div class='result__body'><a class='result__a' href='https://example.com/late'>Later</a></div>`;

    expect(parseDuckDuckGoResults(html, 1)).toEqual([
      { title: "Valid", url: "https://example.com/ok", snippet: "" },
    ]);
    expect(parseDuckDuckGoResults(html, 0)).toEqual([]);
  });
});

describe("parseLiteResults", () => {
  it("pairs each result-link row with its own result-snippet row", () => {
    const html = `
      <table>
        <tr><td>1.</td><td><a rel='nofollow' class='other result-link' href='https://example.com/one?a=1&amp;b=2'>One &amp; <b>only</b></a></td></tr>
        <tr><td></td><td class='other result-snippet'>First &#x26; best</td></tr>
        <tr><td>2.</td><td><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftwo%3Fq%3D%2525" class="result-link">Two</a></td></tr>
        <tr><td></td><td class="result-snippet extra">Second &lt;snippet&gt;</td></tr>
      </table>`;

    expect(parseLiteResults(html, 2)).toEqual([
      { title: "One & only", url: "https://example.com/one?a=1&b=2", snippet: "First & best" },
      { title: "Two", url: "https://example.com/two?q=%25", snippet: "Second <snippet>" },
    ]);
  });

  it("does not assign a later result's snippet to a row without a snippet", () => {
    const html = `
      <table>
        <tr><td><a class='result-link' href='https://example.com/one'>One</a></td></tr>
        <tr><td><a class='result-link' href='https://example.com/two'>Two</a></td></tr>
        <tr><td class='result-snippet'>Second only</td></tr>
        <tr><td><a class='result-link' href='https://example.com/three'>Three</a></td></tr>
      </table>`;

    expect(parseLiteResults(html, 3)).toEqual([
      { title: "One", url: "https://example.com/one", snippet: "" },
      { title: "Two", url: "https://example.com/two", snippet: "Second only" },
      { title: "Three", url: "https://example.com/three", snippet: "" },
    ]);
  });

  it("skips invalid links and applies max to valid results", () => {
    const html = `
      <tr><td><a class='result-link' href='mailto:test@example.com'>Invalid</a></td></tr>
      <tr><td class='result-snippet'>Ignore this</td></tr>
      <tr><td><a class='result-link' href='http://example.com/valid'>Valid</a></td></tr>
      <tr><td class='result-snippet'>Valid snippet</td></tr>
      <tr><td><a class='result-link' href='https://example.com/late'>Late</a></td></tr>`;

    expect(parseLiteResults(html, 1)).toEqual([
      { title: "Valid", url: "http://example.com/valid", snippet: "Valid snippet" },
    ]);
    expect(parseLiteResults(html, 0)).toEqual([]);
  });
});
