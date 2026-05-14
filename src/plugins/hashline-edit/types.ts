// FILE: src/plugins/hashline-edit/types.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the normalized edit operation shapes accepted by the hash-anchored edit executor.
//   SCOPE: Replace, replace_range, append, and prepend operation contracts plus the shared HashlineEdit union.
//   DEPENDS: []
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TYPES
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ReplaceEdit - Replace a single anchored line.
//   ReplaceRangeEdit - Replace an inclusive anchored line range.
//   AppendEdit - Insert content after an optional anchor or at EOF when no anchor is provided.
//   PrependEdit - Insert content before an optional anchor or at BOF when no anchor is provided.
//   HashlineEdit - Union of all normalized hashline edit operations.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.0 - Split "replace" into "replace" (single line) and "replace_range" (range) to prevent accidental end-boundary errors.]
// END_CHANGE_SUMMARY

export interface ReplaceEdit {
  op: "replace";
  pos: string;
  lines: string | string[];
}

export interface ReplaceRangeEdit {
  op: "replace_range";
  pos: string;
  end: string;
  lines: string | string[];
}

export interface AppendEdit {
  op: "append";
  pos?: string;
  lines: string | string[];
}

export interface PrependEdit {
  op: "prepend";
  pos?: string;
  lines: string | string[];
}

export type HashlineEdit = ReplaceEdit | ReplaceRangeEdit | AppendEdit | PrependEdit;
