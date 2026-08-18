// FILE: src/plugins/hashline-edit/replace-engine.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Apply oldString/newString replace edits with the native qwen/kimi harness contract: exact literal matching, limited visible fallback layers, uniqueness rules, and teaching errors. Tool-facing snake_case aliases (old_string/new_string) are resolved to this engine at the plugin layer.
//   SCOPE: Pure content-level replace application with exact, unicode-confusables, and trailing-whitespace layers; occurrence counting; replace-all mode; result formatting with bounded diff summary.
//   DEPENDS: [src/plugins/hashline-edit/diff-summary.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ReplaceEditParams - Tool-facing replace arguments (oldString, newString, replaceAll).
//   ReplaceMatchLayer - Which matching layer produced the applied match.
//   ReplaceApplyResult - Structured outcome: applied content with layer and replacement count, or a teaching error.
//   applyReplaceEdit - Apply a replace edit to file content with layered fail-closed matching.
//   formatReplaceSuccess - Render the success output with stats, warnings, and bounded diff.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Established the replace profile engine with exact, unicode-confusables, and trailing-whitespace layers adapted from the qwen-code contract (Apache-2.0).]
// END_CHANGE_SUMMARY

import { findFirstChangedLine, summarizeEditDiff } from "./diff-summary.js";

// START_BLOCK_TYPES
export interface ReplaceEditParams {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export type ReplaceMatchLayer = "exact" | "unicode_confusables" | "trailing_whitespace";

export type ReplaceApplyResult =
  | {
      ok: true;
      content: string;
      layer: ReplaceMatchLayer;
      replacements: number;
      warnings: string[];
    }
  | {
      ok: false;
      error: string;
      warnings: string[];
    };
// END_BLOCK_TYPES

// START_BLOCK_CONFUSABLES
// Character-level typography normalization adapted from qwen-code editHelper
// (Apache-2.0). Every entry maps one code point to one code point so string
// offsets are preserved between original and normalized text.
const UNICODE_EQUIVALENT_MAP: Record<string, string> = {
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2015": "-",
  "\u2212": "-",
  "\u2018": "'",
  "\u2019": "'",
  "\u201A": "'",
  "\u201B": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u201E": '"',
  "\u201F": '"',
  "\u00A0": " ",
  "\u2002": " ",
  "\u2003": " ",
  "\u2004": " ",
  "\u2005": " ",
  "\u2006": " ",
  "\u2007": " ",
  "\u2008": " ",
  "\u2009": " ",
  "\u200A": " ",
  "\u202F": " ",
  "\u205F": " ",
  "\u3000": " ",
};

function normalizeConfusables(text: string): string {
  let normalized = "";
  for (const char of text) {
    normalized += UNICODE_EQUIVALENT_MAP[char] ?? char;
  }
  return normalized;
}
// END_BLOCK_CONFUSABLES

// START_BLOCK_MATCHING
function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let position = 0;
  while (position < content.length) {
    const index = content.indexOf(needle, position);
    if (index === -1) {
      break;
    }
    count += 1;
    position = index + needle.length;
  }
  return count;
}

interface WhitespaceBlock {
  start: number;
  end: number;
}

function matchTrailingWhitespaceBlocks(content: string, oldString: string): WhitespaceBlock[] {
  const contentLines = content.split("\n");
  const searchLines = oldString.split("\n").map((line) => line.trimEnd());
  if (searchLines.every((line) => line === "")) {
    return [];
  }

  const offsets: number[] = [];
  let cursor = 0;
  for (const line of contentLines) {
    offsets.push(cursor);
    cursor += line.length + 1;
  }

  const blocks: WhitespaceBlock[] = [];
  for (let i = 0; i + searchLines.length <= contentLines.length; i += 1) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j += 1) {
      if ((contentLines[i + j] ?? "").trimEnd() !== searchLines[j]) {
        matches = false;
        break;
      }
    }
    if (!matches) {
      continue;
    }
    const lastIndex = i + searchLines.length - 1;
    blocks.push({
      start: offsets[i]!,
      end: offsets[lastIndex]! + (contentLines[lastIndex] ?? "").length,
    });
    i = lastIndex;
  }
  return blocks;
}

function ambiguityError(count: number): string {
  return (
    `Failed to edit: oldString matches ${count} locations in the file. ` +
    "Provide more surrounding context to make the match unique, or set replaceAll to true to replace every occurrence."
  );
}

function notFoundError(): string {
  return (
    "Failed to edit: oldString not found. The exact text was not found in the file. " +
    "Check whitespace, indentation, and context, and use the Read tool to verify the current " +
    "content before retrying; the file may have changed since you last read it."
  );
}

// Offsets are identical in original and normalized text because every
// confusable maps one code point to one code point.
function replaceNormalizedOccurrences(
  original: string,
  normalized: string,
  normalizedNeedle: string,
  replacement: string,
  all: boolean,
): string {
  let result = "";
  let cursor = 0;
  let position = 0;
  while (position < normalized.length) {
    const index = normalized.indexOf(normalizedNeedle, position);
    if (index === -1) {
      break;
    }
    result += original.slice(cursor, index) + replacement;
    cursor = index + normalizedNeedle.length;
    position = index + normalizedNeedle.length;
    if (!all) {
      break;
    }
  }
  result += original.slice(cursor);
  return result;
}
// END_BLOCK_MATCHING

// START_BLOCK_APPLY
export function applyReplaceEdit(content: string, params: ReplaceEditParams): ReplaceApplyResult {
  const warnings: string[] = [];
  const replaceAll = params.replaceAll ?? false;

  if (params.oldString === params.newString) {
    return {
      ok: false,
      error: "No changes to apply: oldString and newString are identical.",
      warnings,
    };
  }
  if (params.oldString === "") {
    return {
      ok: false,
      error:
        "oldString cannot be empty when editing an existing file. Provide the exact text to replace.",
      warnings,
    };
  }

  // Layer 1: exact literal match.
  const exactCount = countOccurrences(content, params.oldString);
  if (exactCount > 0) {
    if (!replaceAll && exactCount > 1) {
      return { ok: false, error: ambiguityError(exactCount), warnings };
    }
    const next = replaceAll
      ? content.split(params.oldString).join(params.newString)
      : content.replace(params.oldString, params.newString);
    return {
      ok: true,
      content: next,
      layer: "exact",
      replacements: replaceAll ? exactCount : 1,
      warnings,
    };
  }

  // Layer 2: unicode confusables (typography characters equated to ASCII).
  const normalizedContent = normalizeConfusables(content);
  const normalizedOld = normalizeConfusables(params.oldString);
  if (normalizedContent !== content || normalizedOld !== params.oldString) {
    const normalizedCount = countOccurrences(normalizedContent, normalizedOld);
    if (normalizedCount > 0) {
      if (!replaceAll && normalizedCount > 1) {
        return { ok: false, error: ambiguityError(normalizedCount), warnings };
      }
      warnings.push(
        "oldString matched after unicode confusables normalization (typography characters such as curly quotes, dashes, or special spaces were equated to ASCII); the replacement was applied to the original bytes.",
      );
      const next = replaceNormalizedOccurrences(
        content,
        normalizedContent,
        normalizedOld,
        params.newString,
        replaceAll,
      );
      return {
        ok: true,
        content: next,
        layer: "unicode_confusables",
        replacements: replaceAll ? normalizedCount : 1,
        warnings,
      };
    }
  }

  // Layer 3: trailing whitespace ignored per line; indentation stays exact.
  const blocks = matchTrailingWhitespaceBlocks(content, params.oldString);
  if (blocks.length > 0) {
    if (!replaceAll && blocks.length > 1) {
      return { ok: false, error: ambiguityError(blocks.length), warnings };
    }
    warnings.push(
      `oldString matched after ignoring trailing whitespace on ${blocks.length} block(s); leading whitespace (indentation) was matched exactly.`,
    );
    const selected = replaceAll ? blocks : blocks.slice(0, 1);
    let next = content;
    for (let i = selected.length - 1; i >= 0; i -= 1) {
      const block = selected[i]!;
      next = next.slice(0, block.start) + params.newString + next.slice(block.end);
    }
    return {
      ok: true,
      content: next,
      layer: "trailing_whitespace",
      replacements: selected.length,
      warnings,
    };
  }

  return { ok: false, error: notFoundError(), warnings };
}
// END_BLOCK_APPLY

// START_BLOCK_FORMAT
export function formatReplaceSuccess(
  filePath: string,
  beforeContent: string,
  result: { content: string; layer: ReplaceMatchLayer; replacements: number; warnings: string[] },
): string {
  const diff = summarizeEditDiff(beforeContent, result.content);
  const firstChangedLine = findFirstChangedLine(beforeContent, result.content);
  const stats = `+${diff.additions}/-${diff.deletions}${
    firstChangedLine !== undefined ? `, first change line ${firstChangedLine}` : ""
  }`;
  const parts = [`Updated ${filePath} (${stats})`];
  if (result.layer !== "exact") {
    parts.push(`Note: matched via ${result.layer} fallback layer.`);
  }
  if (result.replacements > 1) {
    parts.push(`Note: replaced ${result.replacements} occurrences.`);
  }
  for (const warning of result.warnings) {
    parts.push(`Warning: ${warning}`);
  }
  parts.push(...diff.rendered);
  return parts.join("\n");
}
// END_BLOCK_FORMAT
