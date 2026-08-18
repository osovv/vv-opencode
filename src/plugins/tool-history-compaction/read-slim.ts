// FILE: src/plugins/tool-history-compaction/read-slim.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Collapse old read tool outputs to a compact [Read <file>, lines X-Y] header, recovering the file from the input and the line range from the output when deterministically available.
//   SCOPE: Read input file extraction, line-numbered output range recovery, savings-gated slim decision, and idempotence detection.
//   DEPENDS: [src/plugins/tool-history-compaction/config.ts]
//   LINKS: [M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   fileFromReadInput - Recover the file path from read input aliases.
//   ReadInputLike - Read input object with filePath/path/file aliases.
//   rangeFromReadOutput - Recover the covered line range from a line-numbered output.
//   slimReadOutput - Return the [Read <file>] form when eligible, otherwise null (fallback to pruning).
//   SlimReadResult - Slim form plus measured savings.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Established old-read collapse with fail-closed fallback.]
// END_CHANGE_SUMMARY

import type { ToolHistoryCompactionConfig } from "./config.js";
import { countCodePoints } from "./prune.js";

// START_BLOCK_RANGE
// Matches a line-numbered output line: OpenCode "N| content" / "N: content"
// and hashline anchored "N#ID#ANCHOR|content". Never fabricates a number.
const LINE_NUMBER_PREFIX = /^\s*(\d+)(?:#[^|:]*)?(?:\||:)/;
// END_BLOCK_RANGE

// START_BLOCK_FILE
export interface ReadInputLike {
  filePath?: unknown;
  path?: unknown;
  file?: unknown;
}

/** Recover the file path from read input aliases; unknown values yield undefined. */
export function fileFromReadInput(input: ReadInputLike | undefined): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const key of ["filePath", "path", "file"] as const) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
// END_BLOCK_FILE

// START_BLOCK_RANGE_FN
/**
 * Recover the covered line range ("first-last") from a line-numbered output.
 * Returns undefined when the output is not deterministically line-numbered.
 */
export function rangeFromReadOutput(output: string | undefined): string | undefined {
  if (typeof output !== "string" || output.length === 0) return undefined;
  let first: number | undefined;
  let last: number | undefined;
  for (const line of output.split("\n")) {
    const match = LINE_NUMBER_PREFIX.exec(line);
    if (match) {
      const number = Number.parseInt(match[1] ?? "0", 10);
      if (first === undefined) first = number;
      last = number;
    }
  }
  if (first === undefined || last === undefined || first > last) return undefined;
  return `${first}-${last}`;
}
// END_BLOCK_RANGE_FN

// START_BLOCK_SLIM
export interface SlimReadResult {
  output: string;
  savings: number;
}

function alreadySlimmed(output: string): boolean {
  return output.startsWith("[Read ");
}

/**
 * Collapse an old read output to [Read <file>, lines X-Y] when the file is
 * recoverable and the savings clear the min-savings guard. Returns null when
 * not applicable; the caller falls back to output pruning (never fabricates).
 * @param input - part.state.input.
 * @param output - part.state.output.
 * @param config - resolved compaction config.
 * @returns slim form or null.
 */
export function slimReadOutput(
  input: unknown,
  output: unknown,
  config: ToolHistoryCompactionConfig,
): SlimReadResult | null {
  if (typeof output !== "string" || output.length === 0) return null;
  if (alreadySlimmed(output)) return null;

  const file = fileFromReadInput(input as ReadInputLike | undefined);
  if (file === undefined) return null;

  const range = rangeFromReadOutput(output);
  const slim = range === undefined ? `[Read ${file}]` : `[Read ${file}, lines ${range}]`;
  const savings = countCodePoints(output) - countCodePoints(slim);
  if (savings < config.minSavingsChars) return null;

  return { output: slim, savings };
}
// END_BLOCK_SLIM
