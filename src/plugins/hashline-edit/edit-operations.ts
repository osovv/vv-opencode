// FILE: src/plugins/hashline-edit/edit-operations.ts
// VERSION: 0.6.0
// START_MODULE_CONTRACT
//   PURPOSE: Validate, order, deduplicate, and apply a batch of hashline edit operations against a file snapshot.
//   SCOPE: Batch region computation, comprehensive conflict detection covering all mutation types, exact-edit deduplication, bottom-up application ordering, and no-op reporting.
//   DEPENDS: [src/plugins/hashline-edit/edit-operation-primitives.ts, src/plugins/hashline-edit/types.ts, src/plugins/hashline-edit/validation.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   HashlineApplyReport - Result shape returned after applying a batch of hashline edits.
//   applyHashlineEditsWithReport - Validate and apply a batch of edits while reporting no-ops and deduplicated operations.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.7.0 - Added replace_range support alongside replace to prevent accidental end-boundary errors.]
// END_CHANGE_SUMMARY

import {
  applyAppend,
  applyInsertAfter,
  applyInsertBefore,
  applyPrepend,
  applyReplaceLines,
  applySetLine,
} from "./edit-operation-primitives.js";
import type { HashlineEdit } from "./types.js";
import { normalizeLineRef, parseLineRef, validateLineRefs } from "./validation.js";

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if ((left[index] ?? "") !== (right[index] ?? "")) {
      return false;
    }
  }
  return true;
}

function toLinePayload(lines: string | string[]): string {
  return Array.isArray(lines) ? lines.join("\n") : lines;
}

function getEditLineNumber(edit: HashlineEdit): number {
  switch (edit.op) {
    case "replace":
      return parseLineRef(edit.pos).line;
    case "replace_range":
      return parseLineRef(edit.end).line;
    case "append":
    case "prepend":
      return edit.pos ? parseLineRef(edit.pos).line : Number.NEGATIVE_INFINITY;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

interface EditRegion {
  editIndex: number;
  op: HashlineEdit["op"];
  anchorLine: number;
  startLine: number;
  endLine: number;
  deletesOriginalLines: boolean;
}

function isDeletePayload(lines: string | string[]): boolean {
  return Array.isArray(lines) && lines.length === 0;
}

function computeEditRegions(edits: HashlineEdit[]): EditRegion[] {
  return edits.map((edit, editIndex) => {
    switch (edit.op) {
      case "replace": {
        const startLine = parseLineRef(edit.pos).line;
        return {
          editIndex,
          op: "replace",
          anchorLine: startLine,
          startLine,
          endLine: startLine,
          deletesOriginalLines: isDeletePayload(edit.lines),
        };
      }
      case "replace_range": {
        const startLine = parseLineRef(edit.pos).line;
        const endLine = parseLineRef(edit.end).line;
        return {
          editIndex,
          op: "replace_range",
          anchorLine: startLine,
          startLine,
          endLine,
          deletesOriginalLines: isDeletePayload(edit.lines),
        };
      }
      case "append": {
        const line = edit.pos ? parseLineRef(edit.pos).line : 0;
        return {
          editIndex,
          op: "append",
          anchorLine: line,
          startLine: line,
          endLine: line,
          deletesOriginalLines: false,
        };
      }
      case "prepend": {
        const line = edit.pos ? parseLineRef(edit.pos).line : 0;
        return {
          editIndex,
          op: "prepend",
          anchorLine: line,
          startLine: line,
          endLine: line,
          deletesOriginalLines: false,
        };
      }
    }
  });
}

function collectLineRefs(edits: HashlineEdit[]): string[] {
  return edits.flatMap((edit) => {
    switch (edit.op) {
      case "replace_range":
        return [edit.pos, edit.end];
      case "replace":
        return [edit.pos];
      case "append":
      case "prepend":
        return edit.pos ? [edit.pos] : [];
    }
  });
}

function validateBatchConflicts(regions: EditRegion[]): void {
  const consumed = new Map<number, { editIndex: number; op: string }>();
  const multiLineReplaceRegions = regions.filter(
    (region) => region.op === "replace_range" && region.startLine !== region.endLine,
  );
  const deleteReplaceRegions = regions.filter(
    (region) =>
      (region.op === "replace" || region.op === "replace_range") && region.deletesOriginalLines,
  );

  for (const region of regions) {
    if (region.op !== "replace" && region.op !== "replace_range") continue;
    for (let idx = region.startLine - 1; idx <= region.endLine - 1; idx += 1) {
      const existing = consumed.get(idx);
      if (existing !== undefined) {
        throw new Error(
          `Overlapping edits: edit ${region.editIndex + 1} (lines ${region.startLine}-${region.endLine}, ${region.op}) ` +
            `overlaps with edit ${existing.editIndex + 1} (${existing.op})`,
        );
      }
      consumed.set(idx, { editIndex: region.editIndex, op: region.op });
    }
  }

  for (const region of regions) {
    if (region.op === "replace" || region.op === "replace_range" || region.anchorLine <= 0)
      continue;
    const replaced = multiLineReplaceRegions.find(
      (replaceRegion) =>
        region.anchorLine >= replaceRegion.startLine && region.anchorLine <= replaceRegion.endLine,
    );
    const deleted = deleteReplaceRegions.find(
      (replaceRegion) =>
        region.anchorLine >= replaceRegion.startLine && region.anchorLine <= replaceRegion.endLine,
    );
    const conflict = replaced ?? deleted;
    if (conflict) {
      throw new Error(
        `Conflicting edits: edit ${region.editIndex + 1} (${region.op} at line ${region.anchorLine}) ` +
          `references a line replaced by edit ${conflict.editIndex + 1} (lines ${conflict.startLine}-${conflict.endLine})`,
      );
    }
  }
}

function dedupeEdits(edits: HashlineEdit[]): { edits: HashlineEdit[]; deduplicatedEdits: number } {
  const seen = new Set<string>();
  const deduped: HashlineEdit[] = [];
  let deduplicatedEdits = 0;

  for (const edit of edits) {
    const key = JSON.stringify({
      op: edit.op,
      pos: edit.pos ? normalizeLineRef(edit.pos) : undefined,
      end: "end" in edit && edit.end ? normalizeLineRef(edit.end) : undefined,
      lines: toLinePayload(edit.lines),
    });
    if (seen.has(key)) {
      deduplicatedEdits += 1;
      continue;
    }
    seen.add(key);
    deduped.push(edit);
  }

  return { edits: deduped, deduplicatedEdits };
}

export interface HashlineApplyReport {
  content: string;
  noopEdits: number;
  deduplicatedEdits: number;
}

export function applyHashlineEditsWithReport(
  content: string,
  edits: HashlineEdit[],
): HashlineApplyReport {
  if (edits.length === 0) {
    return {
      content,
      noopEdits: 0,
      deduplicatedEdits: 0,
    };
  }

  const dedupeResult = dedupeEdits(edits);
  const editPrecedence: Record<HashlineEdit["op"], number> = {
    replace_range: 0,
    replace: 1,
    append: 2,
    prepend: 3,
  };
  const sortedEdits = dedupeResult.edits
    .map((edit, index) => ({ edit, index }))
    .sort((left, right) => {
      const leftLine = getEditLineNumber(left.edit);
      const rightLine = getEditLineNumber(right.edit);
      if (leftLine !== rightLine) {
        return rightLine - leftLine;
      }
      const precedenceDelta = editPrecedence[left.edit.op] - editPrecedence[right.edit.op];
      if (precedenceDelta !== 0) {
        return precedenceDelta;
      }
      if (left.edit.op === right.edit.op) {
        if (
          left.edit.op === "append" &&
          left.edit.pos !== undefined &&
          right.edit.pos !== undefined
        ) {
          return right.index - left.index;
        }
        if (left.edit.op === "prepend") {
          return right.index - left.index;
        }
      }
      return left.index - right.index;
    })
    .map((entry) => entry.edit);

  let lines = content.length === 0 ? [] : content.split("\n");

  const regions = computeEditRegions(sortedEdits);
  validateBatchConflicts(regions);

  const refs = collectLineRefs(sortedEdits);
  validateLineRefs(lines, refs);

  let noopEdits = 0;
  for (const edit of sortedEdits) {
    let next = lines;
    switch (edit.op) {
      case "replace_range":
        next = applyReplaceLines(lines, edit.pos, edit.end, edit.lines, { skipValidation: true });
        break;
      case "replace":
        next = applySetLine(lines, edit.pos, edit.lines, { skipValidation: true });
        break;
      case "append":
        next = edit.pos
          ? applyInsertAfter(lines, edit.pos, edit.lines, { skipValidation: true })
          : applyAppend(lines, edit.lines);
        break;
      case "prepend":
        next = edit.pos
          ? applyInsertBefore(lines, edit.pos, edit.lines, { skipValidation: true })
          : applyPrepend(lines, edit.lines);
        break;
    }
    if (arraysEqual(next, lines)) {
      noopEdits += 1;
      continue;
    }
    lines = next;
  }

  return {
    content: lines.join("\n"),
    noopEdits,
    deduplicatedEdits: dedupeResult.deduplicatedEdits,
  };
}
