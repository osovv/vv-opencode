// FILE: src/plugins/hashline-edit/types.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the normalized edit operation shapes accepted by the hash-anchored edit executor.
//   SCOPE: Replace, append, and prepend operation contracts plus the shared HashlineEdit union.
//   DEPENDS: []
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TYPES
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ReplaceEdit - Replace or delete a single line or inclusive range anchored by hashline references.
//   AppendEdit - Insert content after an optional anchor or at EOF when no anchor is provided.
//   PrependEdit - Insert content before an optional anchor or at BOF when no anchor is provided.
//   HashlineEdit - Union of all normalized hashline edit operations.
// END_MODULE_MAP

export interface ReplaceEdit {
  op: "replace";
  pos: string;
  end?: string;
  lines: string | string[] | null;
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

export type HashlineEdit = ReplaceEdit | AppendEdit | PrependEdit;
