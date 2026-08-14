// FILE: src/plugins/hashline-edit/edit-operation-primitives.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Apply validated hashline edit operations literally to an in-memory file snapshot one mutation at a time.
//   SCOPE: Single-line replace, range replace, anchored insert-before/after with exact-match echo trimming, and BOF/EOF insert helpers that preserve trailing-newline sentinels.
//   DEPENDS: [src/plugins/hashline-edit/edit-text-normalization.ts, src/plugins/hashline-edit/validation.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   EditApplyOptions - Optional validation skip and warning collector for primitive apply calls.
//   applySetLine - Replace or delete a single anchored line literally.
//   applyReplaceLines - Replace or delete an inclusive anchored line range literally, trimming only exact boundary echoes.
//   applyInsertAfter - Insert lines after an anchored line, trimming only an exact anchor echo.
//   applyInsertBefore - Insert lines before an anchored line, trimming only an exact anchor echo.
//   applyAppend - Insert lines at EOF without creating a phantom blank line before the trailing newline.
//   applyPrepend - Insert lines at BOF, creating content for an empty file.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.0 - Removed autocorrect and indent restoration, switched echo trimming to exact-match with warnings, and fixed EOF append inserting a phantom blank line before the trailing newline.]
// END_CHANGE_SUMMARY

import {
  stripExactBoundaryEchoes,
  stripExactInsertBeforeEcho,
  stripExactInsertEcho,
  toNewLines,
} from "./edit-text-normalization.js";
import { parseLineRef, validateLineRef } from "./validation.js";

export interface EditApplyOptions {
  skipValidation?: boolean;
  onWarning?: (message: string) => void;
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
  const replacement = newText === null ? [] : toNewLines(newText);

  if (replacement.length > 1) {
    throw new Error(
      "applySetLine: replace is for single-line replacement only. " +
        `Removing 1 line but inserting ${replacement.length} lines. Use applyReplaceLines (replace_range) for multi-line replacement.`,
    );
  }

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
  const normalized = newText === null ? [] : toNewLines(newText);
  const trimmed = stripExactBoundaryEchoes(lines, startLine, endLine, normalized);
  const dropped = trimmed.droppedLeading + trimmed.droppedTrailing;
  if (dropped > 0) {
    options?.onWarning?.(
      `replace_range lines ${startLine}-${endLine}: dropped ${dropped} exact boundary echo line(s) duplicating surviving neighbors; the rest of the payload was applied literally`,
    );
  }

  result.splice(startLine - 1, endLine - startLine + 1, ...trimmed.lines);
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
  const trimmed = stripExactInsertEcho(lines[line - 1] ?? "", toNewLines(text));
  if (trimmed.stripped > 0) {
    options?.onWarning?.(
      `append at line ${line}: dropped payload line identical to the anchor line`,
    );
  }
  if (trimmed.lines.length === 0) {
    throw new Error(`append (anchored) requires non-empty text for ${anchor}`);
  }

  result.splice(line, 0, ...trimmed.lines);
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
  const trimmed = stripExactInsertBeforeEcho(lines[line - 1] ?? "", toNewLines(text));
  if (trimmed.stripped > 0) {
    options?.onWarning?.(
      `prepend at line ${line}: dropped payload line identical to the anchor line`,
    );
  }
  if (trimmed.lines.length === 0) {
    throw new Error(`prepend (anchored) requires non-empty text for ${anchor}`);
  }

  result.splice(line - 1, 0, ...trimmed.lines);
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
  // A newline-terminated file splits into a trailing "" sentinel. Append
  // before it so no phantom blank line is created and the final newline is
  // preserved.
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    return [...lines.slice(0, -1), ...normalized, ""];
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
