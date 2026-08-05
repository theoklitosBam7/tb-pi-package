import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./htmlToMarkdown.js";

describe("htmlToMarkdown", () => {
  it("converts headings to ATX markers", () => {
    const html = "<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("# Title");
    expect(md).toContain("## Subtitle");
    expect(md).toContain("### Section");
  });

  it("converts unordered lists", () => {
    const html = "<ul><li>one</li><li>two</li><li>three</li></ul>";
    const md = htmlToMarkdown(html);
    expect(md).toMatch(/^\* +one/m);
    expect(md).toMatch(/^\* +two/m);
    expect(md).toMatch(/^\* +three/m);
  });

  it("converts ordered lists", () => {
    const html = "<ol><li>first</li><li>second</li></ol>";
    const md = htmlToMarkdown(html);
    expect(md).toMatch(/^1\. +first/m);
    expect(md).toMatch(/^2\. +second/m);
  });

  it("converts links to Markdown format", () => {
    const html = '<p>Visit <a href="https://example.com">Example</a></p>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("[Example](https://example.com)");
  });

  it("converts code blocks to fenced code blocks", () => {
    const html = "<pre><code>const x = 1;</code></pre>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("```\nconst x = 1;\n```");
  });

  it("strips nav, footer, header, aside elements", () => {
    const html =
      "<nav>nav content</nav><main><h1>Main</h1><p>Body text</p></main><footer>footer</footer>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("# Main");
    expect(md).toContain("Body text");
    expect(md).not.toContain("nav content");
    expect(md).not.toContain("footer");
  });

  it("prefers <main> content over surrounding HTML", () => {
    const html =
      "<header>header noise</header><main><h1>Inside Main</h1></main><aside>sidebar</aside>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("# Inside Main");
    expect(md).not.toContain("header noise");
    expect(md).not.toContain("sidebar");
  });

  it("prefers <article> content over surrounding HTML", () => {
    const html =
      "<nav>nav</nav><article><h2>Article Title</h2><p>Content</p></article><footer>foot</footer>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("## Article Title");
    expect(md).toContain("Content");
    expect(md).not.toContain("nav");
    expect(md).not.toContain("foot");
  });

  it("strips script and style elements", () => {
    const html = '<script>alert("xss")</script><style>.x{color:red}</style><p>Hello</p>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("Hello");
    expect(md).not.toContain("alert");
    expect(md).not.toContain("color");
  });

  it("preserves plain text without tags", () => {
    const html = "<p>Just some plain text here.</p>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("Just some plain text here.");
  });

  it("converts full document when no main or article is present", () => {
    const html = "<div><h1>Page Title</h1><p>Body copy</p></div>";
    const md = htmlToMarkdown(html);
    expect(md).toContain("# Page Title");
    expect(md).toContain("Body copy");
  });

  it("strips empty image references", () => {
    const html = '<p><img src="s.gif" /></p><p>Real content</p>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("Real content");
    expect(md).not.toContain("![](");
  });

  it("strips empty links", () => {
    const html = '<p><a href="vote?id=1"></a></p><p>Real content</p>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("Real content");
    expect(md).not.toContain("[](");
  });

  it("preserves normal images with alt text", () => {
    const html = '<p><img src="photo.jpg" alt="A photo" /></p>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("![A photo](photo.jpg)");
  });

  it("preserves normal links with display text", () => {
    const html = '<p><a href="https://example.com">Example</a></p>';
    const md = htmlToMarkdown(html);
    expect(md).toContain("[Example](https://example.com)");
  });

  it("strips HN-style UI noise (regression test)", () => {
    // Real-world Hacker News HTML patterns that produce empty links/images
    const html = `
      <table>
        <tr>
          <td><a href="https://news.ycombinator.com"><img src="y18.svg" width="18" height="18"></a></td>
          <td><b><a href="news">Hacker News</a></b></td>
        </tr>
      </table>
      <a href="vote?id=48334048&amp;how=up&amp;goto=news"><div class="votearrow" title="upvote"></div></a>
      <a href="https://ziglang.org/devlog/2026/#2026-05-26">Zig: Build System Reworked</a>
    `;
    const md = htmlToMarkdown(html);
    expect(md).toContain("**[Hacker News](news)**");
    expect(md).toContain(
      "[Zig: Build System Reworked](https://ziglang.org/devlog/2026/#2026-05-26)",
    );
    expect(md).not.toContain("y18.svg");
    expect(md).not.toContain("vote?id=48334048");
  });
});
