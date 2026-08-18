// FILE: src/plugins/tool-history-compaction/prune.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic head/marker/tail pruning of over-budget tool outputs with code-point-safe slicing, min-savings guard, and marker-based idempotence.
//   SCOPE: Code-point counting and slicing, the fixed prune marker, the prune decision function, and already-compacted detection.
//   DEPENDS: [src/plugins/tool-history-compaction/config.ts]
//   LINKS: [M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PRUNE_MARKER - Fixed marker substituted for every pruned output middle.
//   countCodePoints - Unicode code-point count without splitting surrogate pairs.
//   codePointSlice - Slice text by code points.
//   pruneOutput - Return the pruned form when eligible, otherwise null.
//   alreadyCompacted - Whether text already carries the prune marker.
//   PruneResult - Pruned output plus measured savings.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Established the DSH-style head/marker/tail prune engine.]
// END_CHANGE_SUMMARY

import type { ToolHistoryCompactionConfig } from "./config.js";

// START_BLOCK_CONSTANTS
/** Fixed marker substituted for every pruned output middle. */
export const PRUNE_MARKER = "[... tool output pruned ...]";
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
 * Returns null when the output is ineligible: non-string, pruning disabled,
 * under threshold, already compacted, or savings below minSavingsChars.
 * @param text - tool output text.
 * @param config - resolved compaction config.
 * @returns pruned form or null.
 */
export function pruneOutput(text: string, config: ToolHistoryCompactionConfig): PruneResult | null {
  if (typeof text !== "string" || text.length === 0) return null;
  if (config.outputMaxChars <= 0) return null;
  if (alreadyCompacted(text)) return null;

  const length = countCodePoints(text);
  if (length <= config.outputMaxChars) return null;

  const head = codePointSlice(text, 0, config.headChars);
  const tail = codePointSlice(text, length - config.tailChars, length);
  const output = head + PRUNE_MARKER + tail;
  const savings = length - countCodePoints(output);
  if (savings < config.minSavingsChars) return null;

  return { output, savings };
}
// END_BLOCK_PRUNE
