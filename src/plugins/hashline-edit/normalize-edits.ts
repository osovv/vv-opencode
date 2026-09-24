// FILE: src/plugins/hashline-edit/normalize-edits.ts
// VERSION: 0.6.0
// START_MODULE_CONTRACT
//   PURPOSE: Validate and normalize raw hashline tool arguments into strongly-typed edit operations.
//   SCOPE: Closed raw edit input shape (single-sourced from schemas.ts), anchor trimming, three-part anchor enforcement, blank/malformed provided-anchor rejection, required-field validation, physical single-line payload enforcement, blank-payload rejection for replacements, unified replace (optional end) with replace_range alias, append/prepend normalization with end-anchor fallback, and rejection of truly conflicting pos/end insert references.
//   DEPENDS: [src/lib/agent-tool-contract.ts, src/plugins/hashline-edit/schemas.ts, src/plugins/hashline-edit/types.ts, src/plugins/hashline-edit/validation.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, M-AGENT-TOOL-CONTRACT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   RawHashlineEdit - Tool-facing edit input before validation and normalization (re-exported from schemas.ts).
//   normalizeHashlineEdits - Convert raw tool args into validated HashlineEdit operations.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-005 - Correction cycle: the direct normalizer now runs the schema-owned closed single-edit shape (unknown keys and malformed provided types are rejected instead of stripped) and rejects a provided-but-blank pos/end rather than treating it as absent.]
// END_CHANGE_SUMMARY

import { formatContractIssues } from "../../lib/agent-tool-contract.js";
import type { AppendEdit, HashlineEdit, PrependEdit, ReplaceRangeEdit } from "./types.js";
import { requireThreePartRef } from "./validation.js";
import { validateRawHashlineEditEntry, type RawHashlineEdit } from "./schemas.js";

export type { RawHashlineEdit };

function requireAnchor(value: unknown, index: number, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(
      `Edit ${index}: ${field} must be a string anchor when provided; received ${typeof value}.`,
    );
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error(
      `Edit ${index}: ${field} was provided but is blank. Omit it for boundary/fallback behavior, ` +
        "or supply a full three-part anchor.",
    );
  }
  requireThreePartRef(trimmed, `Edit ${index} ${field}`);
  return trimmed;
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
  // pos is primary and end is the documented fallback, but two references that
  // name different lines would silently drop one: reject that contradiction.
  if (pos !== undefined && end !== undefined && pos !== end) {
    throw new Error(
      `Edit ${index}: ${op} received conflicting pos and end anchors that reference different lines. ` +
        "Provide one anchor, or the same reference for both.",
    );
  }
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
    // Reuse the same closed single-edit shape the registered contract publishes:
    // unknown operation fields and malformed provided types are rejected here
    // instead of being silently stripped by the destructuring below.
    const shape = validateRawHashlineEditEntry(rawEdit, index);
    if (!shape.ok) {
      throw new Error(formatContractIssues(shape.issues));
    }
    const edit = shape.data;

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
