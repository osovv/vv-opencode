// FILE: src/plugins/tool-history-compaction/prune.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic head/marker/tail pruning of over-budget tool outputs with code-point-safe slicing, min-savings guard, marker-based idempotence, and optional disk-path embedding for recoverable pruning.
//   SCOPE: Code-point counting and slicing, the fixed prune marker, the prune decision function, already-compacted detection, and the recoverable-saved-path note.
//   DEPENDS: [src/plugins/tool-history-compaction/config.ts]
//   LINKS: [M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PRUNE_MARKER - Fixed marker substituted for every pruned output middle.
//   SAVED_OUTPUT_NOTE_PREFIX - Prefix introducing the persisted full-output path in a recoverable prune marker.
//   countCodePoints - Unicode code-point count without splitting surrogate pairs.
//   codePointSlice - Slice text by code points.
//   pruneOutput - Return the pruned form when eligible, otherwise null.
//   alreadyCompacted - Whether text already carries the prune marker.
//   PruneResult - Pruned output plus measured savings.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.0 - Added optional saved-path embedding for recoverable pruning.]
// END_CHANGE_SUMMARY

import type { ToolHistoryCompactionConfig } from "./config.js";

// START_BLOCK_CONSTANTS
/** Fixed marker substituted for every pruned output middle. */
export const PRUNE_MARKER = "[... tool output pruned ...]";
/** Prefix introducing the persisted full-output path in a recoverable prune marker. */
export const SAVED_OUTPUT_NOTE_PREFIX = " Full output saved to: ";
// END_BLOCK_CONSTANTS

// START_BLOCK_MEASURE
/** Count Unicode code points without splitting surrogate pairs. */
export function countCodePoints(text: string): number {
  return Array.from(text).length;
}

/** Slice text by code points, never splitting a surrogate pair. */
export function codePointSlice(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join("");
}
// END_BLOCK_MEASURE

// START_BLOCK_DETECT
/** Whether text already carries the prune marker (previous compaction pass). */
export function alreadyCompacted(text: string): boolean {
  return typeof text === "string" && text.includes(PRUNE_MARKER);
}
// END_BLOCK_DETECT

// START_BLOCK_PRUNE
export interface PruneResult {
  output: string;
  savings: number;
}

/**
 * Prune an over-budget output to head + marker + tail.
 * When savedPath is provided, the marker is extended with a recoverable
 * " Full output saved to: <path>" note so the model can re-read the full output.
 * Returns null when the output is ineligible: non-string, pruning disabled,
 * under threshold, already compacted, or savings below minSavingsChars.
 * @param text - tool output text.
 * @param config - resolved compaction config.
 * @param savedPath - optional persisted path of the full output (recoverable pruning).
 * @returns pruned form or null.
 */
export function pruneOutput(
  text: string,
  config: ToolHistoryCompactionConfig,
  savedPath?: string,
): PruneResult | null {
  if (typeof text !== "string" || text.length === 0) return null;
  if (config.outputMaxChars <= 0) return null;
  if (alreadyCompacted(text)) return null;

  const length = countCodePoints(text);
  if (length <= config.outputMaxChars) return null;

  const savedNote =
    typeof savedPath === "string" && savedPath.length > 0
      ? `${SAVED_OUTPUT_NOTE_PREFIX}${savedPath}`
      : "";
  const head = codePointSlice(text, 0, config.headChars);
  const tailChars = Math.max(0, config.tailChars - countCodePoints(savedNote));
  const tail = codePointSlice(text, length - tailChars, length);
  const output = head + PRUNE_MARKER + savedNote + tail;
  const savings = length - countCodePoints(output);
  if (savings < config.minSavingsChars) return null;

  return { output, savings };
}
// END_BLOCK_PRUNE
