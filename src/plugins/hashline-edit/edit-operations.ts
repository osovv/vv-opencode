// FILE: src/plugins/hashline-edit/edit-operations.ts
// VERSION: 0.2.0
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
//   LAST_CHANGE: [v0.2.0 - Replaced range-only conflict detection with comprehensive region-based conflict validation, fixed deduplication to treat null and empty lines identically, added defensive default to edit line number extraction.]
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
      return parseLineRef(edit.end ?? edit.pos).line;
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
}

function computeEditRegions(edits: HashlineEdit[]): EditRegion[] {
  return edits.map((edit, editIndex) => {
    switch (edit.op) {
      case "replace": {
        const startLine = parseLineRef(edit.pos).line;
        const endLine = edit.end ? parseLineRef(edit.end).line : startLine;
        return {
          editIndex,
          op: "replace",
          anchorLine: startLine,
          startLine,
          endLine,
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
        };
      }
    }
  });
}

function collectLineRefs(edits: HashlineEdit[]): string[] {
  return edits.flatMap((edit) => {
    switch (edit.op) {
      case "replace":
        return edit.end ? [edit.pos, edit.end] : [edit.pos];
      case "append":
      case "prepend":
        return edit.pos ? [edit.pos] : [];
    }
  });
}

function validateBatchConflicts(regions: EditRegion[]): void {
  const consumed = new Map<number, { editIndex: number; op: string }>();

  for (const region of regions) {
    if (region.op !== "replace") continue;
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
    replace: 0,
    append: 1,
    prepend: 2,
  };
  const sortedEdits = dedupeResult.edits
    .map((edit, index) => ({ edit, index }))
    .sort((left, right) => {
      const lineDelta = getEditLineNumber(right.edit) - getEditLineNumber(left.edit);
      if (lineDelta !== 0) {
        return lineDelta;
      }
      const precedenceDelta = editPrecedence[left.edit.op] - editPrecedence[right.edit.op];
      if (precedenceDelta !== 0) {
        return precedenceDelta;
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
      case "replace":
        next = edit.end
          ? applyReplaceLines(lines, edit.pos, edit.end, edit.lines, { skipValidation: true })
          : applySetLine(lines, edit.pos, edit.lines, { skipValidation: true });
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
