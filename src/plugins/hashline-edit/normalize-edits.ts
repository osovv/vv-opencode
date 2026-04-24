// FILE: src/plugins/hashline-edit/normalize-edits.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Validate and normalize raw hashline tool arguments into strongly-typed edit operations.
//   SCOPE: Raw edit input shape, anchor trimming, required-field validation, and replace/append/prepend normalization.
//   DEPENDS: [src/plugins/hashline-edit/types.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   RawHashlineEdit - Tool-facing edit input before validation and normalization.
//   normalizeHashlineEdits - Convert raw tool args into validated HashlineEdit operations.
// END_MODULE_MAP

import type { AppendEdit, HashlineEdit, PrependEdit, ReplaceEdit } from "./types.js";

type HashlineToolOp = "replace" | "append" | "prepend";

export interface RawHashlineEdit {
  op?: HashlineToolOp;
  pos?: string;
  end?: string;
  lines?: string | string[] | null;
}

function normalizeAnchor(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function requireLines(edit: RawHashlineEdit, index: number): string | string[] {
  if (edit.lines === undefined) {
    throw new Error(`Edit ${index}: lines is required for ${edit.op ?? "unknown"}`);
  }
  if (edit.lines === null) {
    return [];
  }
  return edit.lines;
}

function requireAnchor(anchor: string | undefined, index: number, op: HashlineToolOp): string {
  if (!anchor) {
    throw new Error(
      `Edit ${index}: ${op} requires at least one anchor line reference (pos or end)`,
    );
  }
  return anchor;
}

function normalizeReplaceEdit(edit: RawHashlineEdit, index: number): HashlineEdit {
  const pos = normalizeAnchor(edit.pos);
  const end = normalizeAnchor(edit.end);
  const anchor = requireAnchor(pos ?? end, index, "replace");
  const lines = requireLines(edit, index);

  const normalized: ReplaceEdit = {
    op: "replace",
    pos: anchor,
    lines,
  };
  if (end) {
    normalized.end = end;
  }
  return normalized;
}

function normalizeInsertEdit(
  edit: RawHashlineEdit,
  index: number,
  op: "append" | "prepend",
): HashlineEdit {
  const pos = normalizeAnchor(edit.pos);
  const end = normalizeAnchor(edit.end);
  const anchor = pos ?? end;
  const lines = requireLines(edit, index);
  const normalized: AppendEdit | PrependEdit = {
    op,
    lines,
  };
  if (anchor) {
    normalized.pos = anchor;
  }
  return normalized;
}

export function normalizeHashlineEdits(rawEdits: RawHashlineEdit[]): HashlineEdit[] {
  return rawEdits.map((rawEdit, index) => {
    const edit = rawEdit ?? {};

    switch (edit.op) {
      case "replace":
        return normalizeReplaceEdit(edit, index);
      case "append":
        return normalizeInsertEdit(edit, index, "append");
      case "prepend":
        return normalizeInsertEdit(edit, index, "prepend");
      default:
        throw new Error(
          `Edit ${index}: unsupported op "${String(edit.op)}". Use replace, append, or prepend.`,
        );
    }
  });
}
