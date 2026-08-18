// FILE: src/plugins/hashline-edit/normalize-edits.ts
// VERSION: 0.5.0
// START_MODULE_CONTRACT
//   PURPOSE: Validate and normalize raw hashline tool arguments into strongly-typed edit operations.
//   SCOPE: Raw edit input shape, anchor trimming, three-part anchor enforcement, required-field validation, physical single-line payload enforcement, blank-payload rejection for replacements, and unified replace (optional end) with replace_range alias plus append/prepend normalization.
//   DEPENDS: [src/plugins/hashline-edit/types.ts, src/plugins/hashline-edit/validation.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   RawHashlineEdit - Tool-facing edit input before validation and normalization.
//   normalizeHashlineEdits - Convert raw tool args into validated HashlineEdit operations.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.5.0 - Unified replace to accept an optional end anchor (range semantics) with replace_range kept as an alias, rejected multi-line replace without end via add-end guidance, and enforced three-part anchors on all edit references.]
// END_CHANGE_SUMMARY

import type { AppendEdit, HashlineEdit, PrependEdit, ReplaceRangeEdit } from "./types.js";
import { requireThreePartRef } from "./validation.js";

type HashlineToolOp = "replace" | "replace_range" | "append" | "prepend";

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

function requireAnchor(
  value: string | undefined,
  index: number,
  field: string,
): string | undefined {
  const anchor = normalizeAnchor(value);
  if (anchor === undefined) {
    return undefined;
  }
  requireThreePartRef(anchor, `Edit ${index} ${field}`);
  return anchor;
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

function normalizeReplaceEdit(edit: RawHashlineEdit, index: number): HashlineEdit {
  const pos = requireAnchor(edit.pos, index, "pos");
  if (!pos) {
    throw new Error(`Edit ${index}: replace requires pos anchor`);
  }
  const end = requireAnchor(edit.end, index, "end");

  const lines = requireLines(edit, index);
  assertNonBlankReplacement(edit, index, lines);
  assertPhysicalLines(edit, index, lines);

  // With an end anchor, replace applies as an inclusive range (pos..end).
  if (end) {
    return { op: "replace_range", pos, end, lines };
  }

  const lineCount = Array.isArray(lines) ? lines.length : lines.split("\n").length;
  if (lineCount > 1) {
    throw new Error(
      `Edit ${index}: replace received ${lineCount} replacement lines but no end anchor. ` +
        "Add the end anchor of the last line to replace (pos..end is inclusive), or pass a single replacement line.",
    );
  }

  return { op: "replace", pos, lines };
}

function normalizeReplaceRangeEdit(edit: RawHashlineEdit, index: number): ReplaceRangeEdit {
  const pos = requireAnchor(edit.pos, index, "pos");
  const end = requireAnchor(edit.end, index, "end");
  if (!pos || !end) {
    throw new Error(`Edit ${index}: replace_range requires both pos and end anchors`);
  }
  const lines = requireLines(edit, index);
  assertNonBlankReplacement(edit, index, lines);
  assertPhysicalLines(edit, index, lines);
  return {
    op: "replace_range",
    pos,
    end,
    lines,
  };
}

function normalizeInsertEdit(
  edit: RawHashlineEdit,
  index: number,
  op: "append" | "prepend",
): HashlineEdit {
  const pos = requireAnchor(edit.pos, index, "pos");
  const end = requireAnchor(edit.end, index, "end");
  const anchor = pos ?? end;
  const lines = requireLines(edit, index);
  assertPhysicalLines(edit, index, lines);
  const normalized: AppendEdit | PrependEdit = {
    op,
    lines,
  };
  if (anchor) {
    normalized.pos = anchor;
  }
  return normalized;
}

function assertPhysicalLines(edit: RawHashlineEdit, index: number, lines: string | string[]): void {
  if (typeof lines === "string") {
    return;
  }
  for (let entryIndex = 0; entryIndex < lines.length; entryIndex += 1) {
    const entry = lines[entryIndex] ?? "";
    if (entry.includes("\n") || entry.includes("\r")) {
      throw new Error(
        `Edit ${index}: lines[${entryIndex}] for ${edit.op ?? "unknown"} contains an embedded newline. ` +
          "Each array entry must be exactly one physical line; split the content into separate entries.",
      );
    }
  }
}

function assertNonBlankReplacement(
  edit: RawHashlineEdit,
  index: number,
  lines: string | string[],
): void {
  const isBlank =
    (typeof lines === "string" && lines === "") ||
    (Array.isArray(lines) && lines.length === 1 && lines[0] === "");
  if (!isBlank) {
    return;
  }
  throw new Error(
    `Edit ${index}: ${edit.op ?? "unknown"} with a single blank line (lines: [""]) is ambiguous and was rejected. ` +
      "To delete lines use lines: [] or lines: null. To insert a blank line use append or prepend.",
  );
}

export function normalizeHashlineEdits(rawEdits: RawHashlineEdit[]): HashlineEdit[] {
  return rawEdits.map((rawEdit, index) => {
    const edit = rawEdit ?? {};

    switch (edit.op) {
      case "replace":
        return normalizeReplaceEdit(edit, index);
      case "replace_range":
        return normalizeReplaceRangeEdit(edit, index);
      case "append":
        return normalizeInsertEdit(edit, index, "append");
      case "prepend":
        return normalizeInsertEdit(edit, index, "prepend");
      default:
        throw new Error(
          `Edit ${index}: unsupported op "${String(edit.op)}". Use replace, replace_range, append, or prepend.`,
        );
    }
  });
}
