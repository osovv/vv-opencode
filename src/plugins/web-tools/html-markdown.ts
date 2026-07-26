// FILE: src/plugins/web-tools/html-markdown.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Convert HTML locally to Markdown or plain text for the native fetch provider.
//   SCOPE: Turndown-based Markdown conversion and htmlparser2-based text extraction, both stripping script and style content.
//   DEPENDS: [turndown, htmlparser2]
//   LINKS: [M-WEB-HTML-MARKDOWN, M-WEB-NATIVE-FETCH]
//   ROLE: UTILITY
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   convertHtmlToMarkdown - Convert an HTML document to GitHub-flavored Markdown.
//   convertHtmlToText - Extract visible text from an HTML document.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial local HTML to Markdown and text conversion for the native fetch provider.]
// END_CHANGE_SUMMARY

import { Parser } from "htmlparser2";
import TurndownService from "turndown";

// START_BLOCK_MARKDOWN
let sharedTurndown: TurndownService | undefined;

function getTurndown(): TurndownService {
  if (!sharedTurndown) {
    sharedTurndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
    sharedTurndown.remove(["script", "style"]);
  }
  return sharedTurndown;
}

/**
 * Convert an HTML document to GitHub-flavored Markdown.
 * Removes script and style content, keeps links as [text](href),
 * and preserves headings, lists, and code blocks.
 * Returns an empty string for empty or whitespace-only input.
 */
export function convertHtmlToMarkdown(html: string): string {
  if (!html || html.trim() === "") {
    return "";
  }
  return getTurndown().turndown(html).trim();
}
// END_BLOCK_MARKDOWN

// START_BLOCK_TEXT
/**
 * Extract visible text from an HTML document.
 * Removes script and style content, decodes entities, and collapses whitespace runs.
 * Returns an empty string for empty or whitespace-only input.
 */
export function convertHtmlToText(html: string): string {
  if (!html || html.trim() === "") {
    return "";
  }
  let text = "";
  let skipDepth = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        if (name === "script" || name === "style") {
          skipDepth += 1;
        }
      },
      ontext(data) {
        if (skipDepth === 0) {
          text += data;
        }
      },
      onclosetag(name) {
        if (name === "script" || name === "style") {
          skipDepth = Math.max(0, skipDepth - 1);
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return text.replace(/\s+/g, " ").trim();
}
// END_BLOCK_TEXT
