// FILE: src/plugins/hashline-edit.edit-operations.test.ts
// VERSION: 0.7.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify hashline batch edit ordering, deduplication, and primitive failure handling.
//   SCOPE: Overlapping and non-overlapping range edits, range/delete insert conflict rejection, same-line precedence, same-anchor insert ordering, repeated BOF prepends, dedupe across anchor normalization, empty anchored insert rejection, BOF/EOF insertion into empty files, trailing-newline sentinel appending, and echo-trim warning propagation.
//   DEPENDS: [bun:test, src/plugins/hashline-edit/edit-operation-primitives.ts, src/plugins/hashline-edit/edit-operations.ts, src/plugins/hashline-edit/hash-computation.ts, src/plugins/hashline-edit/types.ts]
//   LINKS: M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   anchorFor - Build a current line/hash anchor for test fixtures.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.7.0 - Added trailing-newline sentinel append and batch warning-propagation coverage for literal application.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  applyAppend,
  applyInsertAfter,
  applyInsertBefore,
  applyPrepend,
  applySetLine,
} from "./hashline-edit/edit-operation-primitives.js";
import { applyHashlineEditsWithReport } from "./hashline-edit/edit-operations.js";
import { computeAnchorHash, computeLineHash } from "./hashline-edit/hash-computation.js";
import type { HashlineEdit } from "./hashline-edit/types.js";

function anchorFor(lines: string[], line: number): string {
  const content = lines[line - 1] ?? "";
  const hash = computeLineHash(line, content);
  const anchor = computeAnchorHash(line, lines[line - 2], content, lines[line]);
  return `${line}#${hash}#${anchor}`;
}

describe("hashline edit-operations", () => {
  test("throws on overlapping range edits", () => {
    const content = "line 1\nline 2\nline 3\nline 4\nline 5";
    const lines = content.split("\n");
    const edits: HashlineEdit[] = [
      {
        op: "replace_range",
        pos: anchorFor(lines, 1),
        end: anchorFor(lines, 3),
        lines: ["replaced A"],
      },
      {
        op: "replace_range",
        pos: anchorFor(lines, 2),
        end: anchorFor(lines, 4),
        lines: ["replaced B"],
      },
    ];

    expect(() => applyHashlineEditsWithReport(content, edits)).toThrow(/overlap/i);
  });

  test("allows non-overlapping range edits", () => {
    const content = "line 1\nline 2\nline 3\nline 4\nline 5";
    const lines = content.split("\n");
    const edits: HashlineEdit[] = [
      {
        op: "replace_range",
        pos: anchorFor(lines, 1),
        end: anchorFor(lines, 2),
        lines: ["replaced A"],
      },
      {
        op: "replace_range",
        pos: anchorFor(lines, 4),
        end: anchorFor(lines, 5),
        lines: ["replaced B"],
      },
    ];

    expect(applyHashlineEditsWithReport(content, edits).content).toBe(
      "replaced A\nline 3\nreplaced B",
    );
  });

  test("rejects inserts anchored inside a multi-line replaced range", () => {
    const content = "line 1\nline 2\nline 3\nline 4\nline 5";
    const lines = content.split("\n");
    const edits: HashlineEdit[] = [
      {
        op: "replace_range",
        pos: anchorFor(lines, 2),
        end: anchorFor(lines, 4),
        lines: ["replaced"],
      },
      { op: "append", pos: anchorFor(lines, 4), lines: ["should not drift"] },
    ];

    expect(() => applyHashlineEditsWithReport(content, edits)).toThrow(
      /references a line replaced/i,
    );
  });

  test("rejects inserts anchored to a deleted single line", () => {
    const content = "line 1\nline 2\nline 3";
    const lines = content.split("\n");
    const edits: HashlineEdit[] = [
      { op: "replace", pos: anchorFor(lines, 2), lines: [] },
      { op: "append", pos: anchorFor(lines, 2), lines: ["should not drift"] },
    ];

    expect(() => applyHashlineEditsWithReport(content, edits)).toThrow(
      /references a line replaced/i,
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

  test("preserves user order for repeated appends and prepends at the same anchor", () => {
    const content = "line 1\nline 2\nline 3";
    const lines = content.split("\n");
    const anchor = anchorFor(lines, 2);

    expect(
      applyHashlineEditsWithReport(content, [
        { op: "append", pos: anchor, lines: ["after A"] },
        { op: "append", pos: anchor, lines: ["after B"] },
      ]).content,
    ).toBe("line 1\nline 2\nafter A\nafter B\nline 3");

    expect(
      applyHashlineEditsWithReport(content, [
        { op: "prepend", pos: anchor, lines: ["before A"] },
        { op: "prepend", pos: anchor, lines: ["before B"] },
      ]).content,
    ).toBe("line 1\nbefore A\nbefore B\nline 2\nline 3");
  });

  test("preserves user order for repeated unanchored prepends at BOF", () => {
    expect(
      applyHashlineEditsWithReport("line 3", [
        { op: "prepend", lines: ["line 1"] },
        { op: "prepend", lines: ["line 2"] },
      ]).content,
    ).toBe("line 1\nline 2\nline 3");
  });

  test("strips copied context-anchored hashline rows from replacement payloads", () => {
    const content = "alpha\nbeta\ngamma";
    const lines = content.split("\n");
    const anchor = anchorFor(lines, 2);

    expect(
      applyHashlineEditsWithReport(content, [
        { op: "replace", pos: anchor, lines: ["2#KV#JS|new beta"] },
      ]).content,
    ).toBe("alpha\nnew beta\ngamma");
  });

  test("deduplicates edits whose anchors differ only by whitespace", () => {
    const content = "line 1\nline 2";
    const lines = content.split("\n");
    const canonical = anchorFor(lines, 1);
    const spaced = ` 1 # ${canonical.split("#")[1]} # ${canonical.split("#")[2]} `;
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

  test("applySetLine throws when given multi-line replacement", () => {
    const lines = ["line 1", "line 2", "line 3"];

    expect(() =>
      applySetLine(lines, anchorFor(lines, 2), ["replacement A", "replacement B"]),
    ).toThrow(/single-line replacement only/);
  });

  test("rejects replace edit with multi-line payload through batch API", () => {
    const content = "line 1\nline 2\nline 3";
    const lines = content.split("\n");
    const edits: HashlineEdit[] = [
      { op: "replace" as const, pos: anchorFor(lines, 2), lines: ["A", "B"] },
    ];

    expect(() => applyHashlineEditsWithReport(content, edits)).toThrow(
      /single-line replacement only/,
    );
  });
  test("appends before the trailing newline sentinel", () => {
    expect(applyAppend(["line1", ""], ["line2"])).toEqual(["line1", "line2", ""]);
  });

  test("appends literally after a real blank last line of an unterminated file", () => {
    expect(applyAppend(["line1", " "], ["line2"])).toEqual(["line1", " ", "line2"]);
  });

  test("surfaces echo-trim warnings in the batch report", () => {
    const content = "line 1\nline 2\nline 3";
    const lines = content.split("\n");

    const report = applyHashlineEditsWithReport(content, [
      {
        op: "replace_range",
        pos: anchorFor(lines, 2),
        end: anchorFor(lines, 2),
        lines: ["line 1", "new 2", "line 3"],
      },
    ]);

    expect(report.content).toBe("line 1\nnew 2\nline 3");
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toContain("exact boundary echo");
  });

  test("returns no warnings for literal batches", () => {
    const content = "line 1\nline 2";
    const lines = content.split("\n");

    const report = applyHashlineEditsWithReport(content, [
      { op: "replace", pos: anchorFor(lines, 2), lines: ["changed"] },
    ]);

    expect(report.content).toBe("line 1\nchanged");
    expect(report.warnings).toEqual([]);
  });

  test("warns when append payload duplicates the lines already following the anchor", () => {
    const content = "alpha\nbeta\ngamma";
    const lines = content.split("\n");

    const report = applyHashlineEditsWithReport(content, [
      { op: "append", pos: anchorFor(lines, 1), lines: ["beta", "gamma"] },
    ]);

    expect(report.content).toBe("alpha\nbeta\ngamma\nbeta\ngamma");
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toContain("duplicates the 2 line(s) already following the anchor");
  });

  test("warns when prepend payload duplicates the lines already preceding the anchor", () => {
    const content = "alpha\nbeta\ngamma";
    const lines = content.split("\n");

    const report = applyHashlineEditsWithReport(content, [
      { op: "prepend", pos: anchorFor(lines, 3), lines: ["alpha", "beta"] },
    ]);

    expect(report.content).toBe("alpha\nbeta\nalpha\nbeta\ngamma");
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toContain("duplicates the 2 line(s) already preceding the anchor");
  });

  test("does not warn for novel append content", () => {
    const content = "alpha\nbeta";
    const lines = content.split("\n");

    const report = applyHashlineEditsWithReport(content, [
      { op: "append", pos: anchorFor(lines, 2), lines: ["gamma"] },
    ]);

    expect(report.content).toBe("alpha\nbeta\ngamma");
    expect(report.warnings).toEqual([]);
  });
});
