// FILE: src/plugins/tool-history-compaction/saved-output.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Persist the full pruned tool output to a deterministic disk location so the prune marker can embed a recoverable path, mirroring OpenCode's own over-limit output mechanism.
//   SCOPE: Deterministic saved-output directory and file path derivation from part callID, write-once idempotent persistence, and path-return semantics.
//   DEPENDS: [node:fs, node:path, src/lib/vvoc-paths.ts]
//   LINKS: [M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   TOOL_OUTPUT_DIR_NAME - Directory name under the vvoc data root holding persisted pruned outputs.
//   savedOutputDir - Resolve the vvoc tool-output directory (created lazily by the write helper).
//   savedOutputPath - Deterministic absolute file path for a tool call's pruned output.
//   savePrunedOutputOnce - Write the full output once per callID; returns the path or undefined.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.0 - Added disk-backed recovery of pruned tool outputs.]
// END_CHANGE_SUMMARY

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getGlobalVvocDataDir } from "../../lib/vvoc-paths.js";

// START_BLOCK_DIR
/** Directory name under the vvoc data root holding persisted pruned outputs. */
export const TOOL_OUTPUT_DIR_NAME = "tool-output";
// END_BLOCK_DIR

// START_BLOCK_PATH
/** Resolve the vvoc tool-output directory under the global vvoc data root. */
export function savedOutputDir(dataHomeOverride?: string): string {
  return join(getGlobalVvocDataDir(dataHomeOverride), TOOL_OUTPUT_DIR_NAME);
}

/** Sanitize a callID into a deterministic safe filename segment. */
function sanitizeCallId(callId: string): string {
  const sanitized = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return /[a-zA-Z0-9]/.test(sanitized) ? sanitized : "unknown";
}

/** Deterministic absolute file path for a tool call's pruned output. */
export function savedOutputPath(callId: string, dataHomeOverride?: string): string {
  return join(savedOutputDir(dataHomeOverride), `tool-${sanitizeCallId(callId)}.txt`);
}
// END_BLOCK_PATH

// START_BLOCK_SAVE
/**
 * Write the full output to disk once per callID and return its path.
 * Returns undefined when the write cannot be performed so callers can fall back
 * to a non-recoverable prune marker.
 * @param output - the full original tool output to persist.
 * @param callId - the tool part callID used for a deterministic filename.
 * @param dataHomeOverride - optional XDG data home override (tests).
 * @returns the persisted absolute path, or undefined when the file already exists as this call's file or the write fails.
 */
export function savePrunedOutputOnce(
  output: string,
  callId: string,
  dataHomeOverride?: string,
): string | undefined {
  if (typeof output !== "string" || output.length === 0) return undefined;
  if (typeof callId !== "string" || callId.length === 0) return undefined;

  const path = savedOutputPath(callId, dataHomeOverride);
  try {
    if (!existsSync(path)) {
      mkdirSync(savedOutputDir(dataHomeOverride), { recursive: true });
      writeFileSync(path, output, { encoding: "utf8", flag: "wx" });
    }
    return path;
  } catch {
    return undefined;
  }
}
// END_BLOCK_SAVE
