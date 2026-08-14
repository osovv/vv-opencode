// FILE: src/plugins/hashline-edit/normalize-edits.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Validate and normalize raw hashline tool arguments into strongly-typed edit operations.
//   SCOPE: Raw edit input shape, anchor trimming, required-field validation, physical single-line payload enforcement, blank-payload rejection for replacements, and replace/replace_range/append/prepend normalization.
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
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.0 - Rejected embedded newlines inside array payload entries and blank-only replace/replace_range payloads with teaching errors.]
// END_CHANGE_SUMMARY

import type {
  AppendEdit,
  HashlineEdit,
  PrependEdit,
  ReplaceEdit,
  ReplaceRangeEdit,
} from "./types.js";

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

function requireLines(edit: RawHashlineEdit, index: number): string | string[] {
  if (edit.lines === undefined) {
    throw new Error(`Edit ${index}: lines is required for ${edit.op ?? "unknown"}`);
  }
  if (edit.lines === null) {
    return [];
  }
  return edit.lines;
}

function normalizeReplaceEdit(edit: RawHashlineEdit, index: number): ReplaceEdit {
  const pos = normalizeAnchor(edit.pos);
  if (!pos) {
    throw new Error(`Edit ${index}: replace requires pos anchor`);
  }
  if (edit.end !== undefined && edit.end !== null && edit.end.trim() !== "") {
    throw new Error(
      `Edit ${index}: replace does not accept end — use "replace_range" for multi-line replacements`,
    );
  }
  if (Array.isArray(edit.lines) && edit.lines.length > 1) {
    throw new Error(
      `Edit ${index}: replace is for single-line replacement only. ` +
        `You passed ${edit.lines.length} replacement lines. Use "replace_range" with pos + end for multi-line replacement.`,
    );
  }

  const lines = requireLines(edit, index);
  assertNonBlankReplacement(edit, index, lines);
  if (typeof lines === "string" && (lines.includes("\n") || lines.includes("\r"))) {
    throw new Error(
      `Edit ${index}: replace received a string payload with embedded newlines. ` +
        'Use "replace_range" with pos + end for multi-line replacement.',
    );
  }
  assertPhysicalLines(edit, index, lines);

  return {
    op: "replace",
    pos,
    lines,
  };
}

function normalizeReplaceRangeEdit(edit: RawHashlineEdit, index: number): ReplaceRangeEdit {
  const pos = normalizeAnchor(edit.pos);
  const end = normalizeAnchor(edit.end);
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
  const pos = normalizeAnchor(edit.pos);
  const end = normalizeAnchor(edit.end);
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
