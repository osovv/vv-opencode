// FILE: src/plugins/hashline-edit.edit-operations.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify hashline batch edit ordering, deduplication, and primitive failure handling.
//   SCOPE: Overlapping and non-overlapping range edits, same-line precedence, dedupe across anchor normalization, empty anchored insert rejection, and BOF/EOF insertion into empty files.
//   DEPENDS: [bun:test, src/plugins/hashline-edit/edit-operation-primitives.ts, src/plugins/hashline-edit/edit-operations.ts, src/plugins/hashline-edit/hash-computation.ts, src/plugins/hashline-edit/types.ts]
//   LINKS: [V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   hashline edit-operations tests - Verify batch ordering, deduplication, and primitive failure behavior.
// END_MODULE_MAP

import { describe, expect, test } from "bun:test";
import {
  applyAppend,
  applyInsertAfter,
  applyInsertBefore,
  applyPrepend,
} from "./hashline-edit/edit-operation-primitives.js";
import { applyHashlineEditsWithReport } from "./hashline-edit/edit-operations.js";
import { computeLineHash } from "./hashline-edit/hash-computation.js";
import type { HashlineEdit } from "./hashline-edit/types.js";

function anchorFor(lines: string[], line: number): string {
  return `${line}#${computeLineHash(line, lines[line - 1] ?? "")}`;
}

describe("hashline edit-operations", () => {
  test("throws on overlapping range edits", () => {
    const content = "line 1\nline 2\nline 3\nline 4\nline 5";
    const lines = content.split("\n");
    const edits: HashlineEdit[] = [
      { op: "replace", pos: anchorFor(lines, 1), end: anchorFor(lines, 3), lines: ["replaced A"] },
      { op: "replace", pos: anchorFor(lines, 2), end: anchorFor(lines, 4), lines: ["replaced B"] },
    ];

    expect(() => applyHashlineEditsWithReport(content, edits)).toThrow(/overlap/i);
  });

  test("allows non-overlapping range edits", () => {
    const content = "line 1\nline 2\nline 3\nline 4\nline 5";
    const lines = content.split("\n");
    const edits: HashlineEdit[] = [
      { op: "replace", pos: anchorFor(lines, 1), end: anchorFor(lines, 2), lines: ["replaced A"] },
      { op: "replace", pos: anchorFor(lines, 4), end: anchorFor(lines, 5), lines: ["replaced B"] },
    ];

    expect(applyHashlineEditsWithReport(content, edits).content).toBe(
      "replaced A\nline 3\nreplaced B",
    );
  });

  test("applies replace before prepend when both target the same line", () => {
    const content = "line 1\nline 2\nline 3";
    const lines = content.split("\n");
    const edits: HashlineEdit[] = [
      { op: "prepend", pos: anchorFor(lines, 2), lines: ["before line 2"] },
      { op: "replace", pos: anchorFor(lines, 2), lines: ["modified line 2"] },
    ];

    expect(applyHashlineEditsWithReport(content, edits).content).toBe(
      "line 1\nbefore line 2\nmodified line 2\nline 3",
    );
  });

  test("deduplicates edits whose anchors differ only by whitespace", () => {
    const content = "line 1\nline 2";
    const lines = content.split("\n");
    const canonical = anchorFor(lines, 1);
    const spaced = ` 1 # ${canonical.split("#")[1]} `;
    const report = applyHashlineEditsWithReport(content, [
      { op: "append", pos: canonical, lines: ["inserted"] },
      { op: "append", pos: spaced, lines: ["inserted"] },
    ]);

    expect(report.deduplicatedEdits).toBe(1);
    expect(report.content).toBe("line 1\ninserted\nline 2");
  });

  test("throws when anchored append payload only repeats the anchor line", () => {
    const lines = ["line 1", "line 2"];

    expect(() => applyInsertAfter(lines, anchorFor(lines, 1), ["line 1"])).toThrow(/non-empty/i);
  });

  test("throws when anchored prepend payload only repeats the anchor line", () => {
    const lines = ["line 1", "line 2"];

    expect(() => applyInsertBefore(lines, anchorFor(lines, 2), ["line 2"])).toThrow(/non-empty/i);
  });

  test("appends to an empty file without introducing an extra blank line", () => {
    expect(applyAppend([""], ["line1"])).toEqual(["line1"]);
  });

  test("prepends to an empty file without introducing an extra blank line", () => {
    expect(applyPrepend([""], ["line1"])).toEqual(["line1"]);
  });
});
