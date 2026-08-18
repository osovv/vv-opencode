// FILE: src/plugins/hashline-edit/diff-summary.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Compute bounded before/after diff summaries shared by all edit profiles.
//   SCOPE: First changed line detection and bounded rendered diff with addition/deletion counts.
//   DEPENDS: [none]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   EditDiffSummary - Addition/deletion counts plus bounded rendered diff lines.
//   summarizeEditDiff - Produce a bounded unified-style diff between two file contents.
//   findFirstChangedLine - Return the 1-based first differing line between two contents.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Extracted bounded diff helpers from the hashline plugin index for reuse across edit profiles.]
// END_CHANGE_SUMMARY

// START_BLOCK_CONSTANTS
const DIFF_CONTEXT_LINES = 2;
const DIFF_MAX_RENDERED_LINES = 40;
// END_BLOCK_CONSTANTS

// START_BLOCK_SUMMARY
export interface EditDiffSummary {
  additions: number;
  deletions: number;
  rendered: string[];
}

export function summarizeEditDiff(beforeContent: string, afterContent: string): EditDiffSummary {
  const before = beforeContent.length === 0 ? [] : beforeContent.split("\n");
  const after = afterContent.length === 0 ? [] : afterContent.split("\n");

  const minLen = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < minLen && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  if (removed.length === 0 && added.length === 0) {
    return { additions: 0, deletions: 0, rendered: [] };
  }

  const rendered: string[] = [`@@ changed lines ${prefix + 1} @@`];
  const contextStart = Math.max(0, prefix - DIFF_CONTEXT_LINES);
  for (let i = contextStart; i < prefix; i += 1) {
    rendered.push(`  ${before[i]}`);
  }
  for (const line of removed) {
    rendered.push(`- ${line}`);
  }
  for (const line of added) {
    rendered.push(`+ ${line}`);
  }
  const tailStart = before.length - suffix;
  const contextEnd = Math.min(before.length, tailStart + DIFF_CONTEXT_LINES);
  for (let i = tailStart; i < contextEnd; i += 1) {
    rendered.push(`  ${after[i]}`);
  }

  if (rendered.length > DIFF_MAX_RENDERED_LINES) {
    const kept = rendered.slice(0, DIFF_MAX_RENDERED_LINES - 1);
    kept.push(`… (${rendered.length - kept.length} more diff lines)`);
    return { additions: added.length, deletions: removed.length, rendered: kept };
  }
  return { additions: added.length, deletions: removed.length, rendered };
}
// END_BLOCK_SUMMARY

// START_BLOCK_FIRST_CHANGED
export function findFirstChangedLine(
  beforeContent: string,
  afterContent: string,
): number | undefined {
  const beforeLines = beforeContent.split("\n");
  const afterLines = afterContent.split("\n");
  const maxLength = Math.max(beforeLines.length, afterLines.length);

  for (let index = 0; index < maxLength; index += 1) {
    if ((beforeLines[index] ?? "") !== (afterLines[index] ?? "")) {
      return index + 1;
    }
  }
  return undefined;
}
// END_BLOCK_FIRST_CHANGED
