// FILE: src/plugins/tool-history-compaction/retention.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Classify tool outputs into knowledge (retained) versus ephemeral (compaction-eligible) by case-insensitive substring matching on the tool name.
//   SCOPE: The pure isRetainedTool predicate; the default retention list is re-exported from the shared lib table.
//   DEPENDS: [src/lib/plugin-toggle-config.ts]
//   LINKS: [M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   DEFAULT_RETAIN_TOOLS - Default knowledge-tool substrings (re-exported from the shared lib table).
//   RetainTools - Readonly array of case-insensitive tool-name substrings.
//   isRetainedTool - Whether a tool name matches any retain substring.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Established the knowledge-versus-ephemeral retention classification; defaults owned by the shared lib table.]
// END_CHANGE_SUMMARY
import { DEFAULT_TOOL_HISTORY_COMPACTION_RETAIN_TOOLS } from "../../lib/plugin-toggle-config.js";

// START_BLOCK_DEFAULTS
/** Knowledge-tool substrings: results that stay relevant for the whole session. */
export const DEFAULT_RETAIN_TOOLS: readonly string[] = DEFAULT_TOOL_HISTORY_COMPACTION_RETAIN_TOOLS;

export type RetainTools = readonly string[];

// END_BLOCK_DEFAULTS

// START_BLOCK_MATCH
/**
 * Whether a tool name matches any retain substring, case-insensitively.
 * @param tool - tool name from a message part.
 * @param retainTools - configured retain substrings.
 * @returns true when the tool output must never be compacted.
 */
export function isRetainedTool(tool: string | undefined, retainTools: RetainTools): boolean {
  if (typeof tool !== "string" || tool.length === 0) return false;
  const lower = tool.toLowerCase();
  for (const pattern of retainTools) {
    if (pattern.length > 0 && lower.includes(pattern.toLowerCase())) {
      return true;
    }
  }
  return false;
}
// END_BLOCK_MATCH
