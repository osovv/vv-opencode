// FILE: src/plugins/hashline-edit/tool-description.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide the LLM-facing tool description for the hash-anchored edit override.
//   SCOPE: Stable instructions for read-then-edit workflow, anchor usage, operation choice, and stale-anchor recovery.
//   DEPENDS: []
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   HASHLINE_EDIT_DESCRIPTION - Canonical LLM-facing description for the hashline-backed `edit` tool.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.3.0 - Updated copied-row warning to include context-anchored hashline row format.]
// END_CHANGE_SUMMARY

export const HASHLINE_EDIT_DESCRIPTION = `Edit files using exact hash-anchored line references from the latest Read output.

Workflow:
1. Read the file and copy anchors in \`{line}#{hash}#{anchor}\` form from rows like \`42#VK#AB|content\` (backward-compatible \`{line}#{hash}\` anchors also accepted).
2. Submit one \`edit\` call per file with the smallest possible set of replace/append/prepend operations.
3. If the same file needs another call after a successful edit, re-read it first.

Rules:
- Every anchored edit must use exact current \`{line}#{hash}\` or \`{line}#{hash}#{anchor}\` values from the latest Read output.
- All edits in one call target the ORIGINAL file snapshot; do not adjust line numbers for earlier edits in the same batch.
- \`replace\` with \`pos\` only replaces one line.
- \`replace\` with \`pos\` and \`end\` replaces the inclusive range \`pos..end\`.
- \`append\` inserts after the anchor, or at EOF when no anchor is provided.
- \`prepend\` inserts before the anchor, or at BOF when no anchor is provided.
- \`lines: null\` or \`lines: []\` with \`replace\` deletes the targeted line or range.
- \`lines\` must contain plain replacement content only, not copied \`line#hash#anchor|content\` rows.
- Prefer one operation per logical mutation site instead of a single oversized replace.

Recovery:
- If you get a hash mismatch error, copy the updated anchors shown in that error or re-read the file before retrying.`;
