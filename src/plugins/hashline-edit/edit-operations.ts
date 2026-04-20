// FILE: src/plugins/hashline-edit/edit-operations.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Validate, order, deduplicate, and apply a batch of hashline edit operations against a file snapshot.
//   SCOPE: Batch anchor collection, overlap detection, exact-edit deduplication, bottom-up application ordering, and no-op reporting.
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

function toLinePayload(lines: string | string[] | null): string {
  if (lines === null) {
    return "<delete>";
  }
  return Array.isArray(lines) ? lines.join("\n") : lines;
}

function getEditLineNumber(edit: HashlineEdit): number {
  switch (edit.op) {
    case "replace":
      return parseLineRef(edit.end ?? edit.pos).line;
    case "append":
    case "prepend":
      return edit.pos ? parseLineRef(edit.pos).line : Number.NEGATIVE_INFINITY;
  }
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

function detectOverlappingRanges(edits: HashlineEdit[]): string | null {
  const ranges: Array<{ start: number; end: number; index: number }> = [];
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index];
    if (!edit || edit.op !== "replace" || !edit.end) {
      continue;
    }
    ranges.push({
      start: parseLineRef(edit.pos).line,
      end: parseLineRef(edit.end).line,
      index,
    });
  }

  if (ranges.length < 2) {
    return null;
  }

  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1]!;
    const current = ranges[index]!;
    if (current.start <= previous.end) {
      return `Overlapping range edits detected: edit ${previous.index + 1} (lines ${previous.start}-${previous.end}) overlaps with edit ${current.index + 1} (lines ${current.start}-${current.end}).`;
    }
  }

  return null;
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

  const overlapError = detectOverlappingRanges(sortedEdits);
  if (overlapError) {
    throw new Error(overlapError);
  }

  const refs = collectLineRefs(sortedEdits);
  let lines = content.length === 0 ? [] : content.split("\n");
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
