// FILE: src/plugins/web-tools/html-markdown.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify local HTML to Markdown and text conversion.
//   SCOPE: Script and style stripping, link and heading and list conversion, code block preservation, entity decoding, whitespace collapse, and empty input handling.
//   DEPENDS: [bun:test, src/plugins/web-tools/html-markdown.ts]
//   LINKS: [M-WEB-HTML-MARKDOWN, V-M-WEB-HTML-MARKDOWN]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   HIDDEN_CONTENT_HTML - HTML fixture containing visible, script, and style content.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial coverage for the local HTML converter.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { convertHtmlToMarkdown, convertHtmlToText } from "./html-markdown.js";

const HIDDEN_CONTENT_HTML = "<p>ok</p><script>evil()</script><style>.x{color:red}</style>";

describe("convertHtmlToMarkdown", () => {
  test("removes script and style content", () => {
    const markdown = convertHtmlToMarkdown(HIDDEN_CONTENT_HTML);
    expect(markdown).toContain("ok");
    expect(markdown).not.toContain("evil");
    expect(markdown).not.toContain("color:red");
  });

  test("converts anchors to markdown links with href preserved", () => {
    const markdown = convertHtmlToMarkdown('<p>see <a href="https://x.test">docs</a></p>');
    expect(markdown).toContain("[docs](https://x.test)");
  });

  test("converts headings and lists to markdown equivalents", () => {
    const markdown = convertHtmlToMarkdown("<h2>Title</h2><ul><li>one</li><li>two</li></ul>");
    expect(markdown).toMatch(/#+ Title/);
    expect(markdown).toContain("one");
    expect(markdown).toContain("two");
  });

  test("preserves preformatted code blocks", () => {
    const markdown = convertHtmlToMarkdown("<pre><code>const x = 1;</code></pre>");
    expect(markdown).toContain("const x = 1;");
  });

  test("returns an empty string for empty or whitespace-only input", () => {
    expect(convertHtmlToMarkdown("")).toBe("");
    expect(convertHtmlToMarkdown("   \n  ")).toBe("");
  });
});

describe("convertHtmlToText", () => {
  test("removes script and style content", () => {
    const text = convertHtmlToText(
      "<p>hello</p><script>evil()</script><style>.x{color:red}</style>",
    );
    expect(text).toContain("hello");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("color:red");
  });

  test("collapses whitespace runs", () => {
    expect(convertHtmlToText("<p>foo   bar\n\nbaz</p>")).toBe("foo bar baz");
  });

  test("decodes entities", () => {
    expect(convertHtmlToText("<p>a &amp; b</p>")).toBe("a & b");
  });

  test("returns an empty string for empty or whitespace-only input", () => {
    expect(convertHtmlToText("")).toBe("");
    expect(convertHtmlToText("  \n ")).toBe("");
  });
});
