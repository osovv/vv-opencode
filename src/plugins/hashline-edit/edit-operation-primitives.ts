// FILE: src/plugins/hashline-edit/edit-operation-primitives.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Apply validated hashline edit operations to an in-memory file snapshot one mutation at a time.
//   SCOPE: Single-line replace, range replace, anchored insert-before/after, and BOF/EOF insert helpers.
//   DEPENDS: [src/plugins/hashline-edit/autocorrect-replacement-lines.ts, src/plugins/hashline-edit/edit-text-normalization.ts, src/plugins/hashline-edit/validation.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   applySetLine - Replace or delete a single anchored line.
//   applyReplaceLines - Replace or delete an inclusive anchored line range.
//   applyInsertAfter - Insert lines after an anchored line.
//   applyInsertBefore - Insert lines before an anchored line.
//   applyAppend - Insert lines at EOF, creating content for an empty file.
//   applyPrepend - Insert lines at BOF, creating content for an empty file.
// END_MODULE_MAP

import { autocorrectReplacementLines } from "./autocorrect-replacement-lines.js";
import {
  restoreLeadingIndent,
  stripInsertAnchorEcho,
  stripInsertBeforeEcho,
  stripRangeBoundaryEcho,
  toNewLines,
} from "./edit-text-normalization.js";
import { parseLineRef, validateLineRef } from "./validation.js";

interface EditApplyOptions {
  skipValidation?: boolean;
}

function shouldValidate(options?: EditApplyOptions): boolean {
  return options?.skipValidation !== true;
}

export function applySetLine(
  lines: string[],
  anchor: string,
  newText: string | string[] | null,
  options?: EditApplyOptions,
): string[] {
  if (shouldValidate(options)) {
    validateLineRef(lines, anchor);
  }

  const { line } = parseLineRef(anchor);
  const result = [...lines];
  const originalLine = lines[line - 1] ?? "";
  const normalized = newText === null ? [] : toNewLines(newText);
  const corrected = autocorrectReplacementLines([originalLine], normalized);
  const replacement = corrected.map((entry, index) => {
    if (index !== 0) {
      return entry;
    }
    return restoreLeadingIndent(originalLine, entry);
  });

  result.splice(line - 1, 1, ...replacement);
  return result;
}

export function applyReplaceLines(
  lines: string[],
  startAnchor: string,
  endAnchor: string,
  newText: string | string[] | null,
  options?: EditApplyOptions,
): string[] {
  if (shouldValidate(options)) {
    validateLineRef(lines, startAnchor);
    validateLineRef(lines, endAnchor);
  }

  const { line: startLine } = parseLineRef(startAnchor);
  const { line: endLine } = parseLineRef(endAnchor);
  if (startLine > endLine) {
    throw new Error(
      `Invalid range: start line ${startLine} cannot be greater than end line ${endLine}`,
    );
  }

  const result = [...lines];
  const originalRange = lines.slice(startLine - 1, endLine);
  const normalized = newText === null ? [] : toNewLines(newText);
  const stripped = stripRangeBoundaryEcho(lines, startLine, endLine, normalized);
  const corrected = autocorrectReplacementLines(originalRange, stripped);
  const restored = corrected.map((entry, index) => {
    if (index !== 0) {
      return entry;
    }
    return restoreLeadingIndent(lines[startLine - 1] ?? "", entry);
  });

  result.splice(startLine - 1, endLine - startLine + 1, ...restored);
  return result;
}

export function applyInsertAfter(
  lines: string[],
  anchor: string,
  text: string | string[],
  options?: EditApplyOptions,
): string[] {
  if (shouldValidate(options)) {
    validateLineRef(lines, anchor);
  }

  const { line } = parseLineRef(anchor);
  const result = [...lines];
  const newLines = stripInsertAnchorEcho(lines[line - 1] ?? "", toNewLines(text));
  if (newLines.length === 0) {
    throw new Error(`append (anchored) requires non-empty text for ${anchor}`);
  }

  result.splice(line, 0, ...newLines);
  return result;
}

export function applyInsertBefore(
  lines: string[],
  anchor: string,
  text: string | string[],
  options?: EditApplyOptions,
): string[] {
  if (shouldValidate(options)) {
    validateLineRef(lines, anchor);
  }

  const { line } = parseLineRef(anchor);
  const result = [...lines];
  const newLines = stripInsertBeforeEcho(lines[line - 1] ?? "", toNewLines(text));
  if (newLines.length === 0) {
    throw new Error(`prepend (anchored) requires non-empty text for ${anchor}`);
  }

  result.splice(line - 1, 0, ...newLines);
  return result;
}

export function applyAppend(lines: string[], text: string | string[]): string[] {
  const normalized = toNewLines(text);
  if (normalized.length === 0) {
    throw new Error("append requires non-empty text");
  }
  if (lines.length === 1 && lines[0] === "") {
    return [...normalized];
  }
  return [...lines, ...normalized];
}

export function applyPrepend(lines: string[], text: string | string[]): string[] {
  const normalized = toNewLines(text);
  if (normalized.length === 0) {
    throw new Error("prepend requires non-empty text");
  }
  if (lines.length === 1 && lines[0] === "") {
    return [...normalized];
  }
  return [...normalized, ...lines];
}
