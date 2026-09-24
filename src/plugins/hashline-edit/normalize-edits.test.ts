// FILE: src/plugins/hashline-edit/normalize-edits.test.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify raw hashline edit normalization into typed operations.
//   SCOPE: Replace normalization, anchored append/prepend normalization, end-anchor fallback, conflicting pos/end rejection, closed-shape unknown-key and malformed-type rejection, blank-provided-anchor rejection, required-lines failures, null-to-empty-array conversion for inserts, unsupported-op failures, embedded-newline entry rejection, and blank-only replacement rejection.
//   DEPENDS: [bun:test, src/plugins/hashline-edit/normalize-edits.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   [test scenarios] - Hashline normalization coverage is expressed through module-level tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-005 - Correction cycle: added direct-entry unknown-key, malformed provided-type, and provided-but-blank anchor regressions after the normalizer adopted the schema-owned closed edit shape.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { normalizeHashlineEdits, type RawHashlineEdit } from "./normalize-edits.js";

describe("hashline normalize-edits", () => {
  test("maps replace with pos to a replace edit", () => {
    const input: RawHashlineEdit[] = [{ op: "replace", pos: "2#VK#ZZ", lines: "updated" }];

    expect(normalizeHashlineEdits(input)).toEqual([
      { op: "replace", pos: "2#VK#ZZ", lines: "updated" },
    ]);
  });

  test("maps replace_range with pos and end to a ranged replace edit", () => {
    const input: RawHashlineEdit[] = [
      { op: "replace_range", pos: "2#VK#ZZ", end: "4#MB#ZZ", lines: ["a", "b"] },
    ];

    expect(normalizeHashlineEdits(input)).toEqual([
      { op: "replace_range", pos: "2#VK#ZZ", end: "4#MB#ZZ", lines: ["a", "b"] },
    ]);
  });

  test("maps replace with end to a ranged replace edit", () => {
    const input: RawHashlineEdit[] = [
      { op: "replace", pos: "2#VK#ZZ", end: "4#MB#ZZ", lines: ["a"] },
    ];

    expect(normalizeHashlineEdits(input)).toEqual([
      { op: "replace_range", pos: "2#VK#ZZ", end: "4#MB#ZZ", lines: ["a"] },
    ]);
  });

  test("rejects replace_range without end", () => {
    const input: RawHashlineEdit[] = [{ op: "replace_range", pos: "2#VK#ZZ", lines: ["a"] }];

    expect(() => normalizeHashlineEdits(input)).toThrow(/requires both pos and end/i);
  });

  test("rejects replace with multi-line lines payload", () => {
    const input: RawHashlineEdit[] = [{ op: "replace", pos: "2#VK#ZZ", lines: ["line1", "line2"] }];

    expect(() => normalizeHashlineEdits(input)).toThrow(/no end anchor/i);
  });

  test("maps anchored append and prepend while preserving op", () => {
    const input: RawHashlineEdit[] = [
      { op: "append", pos: "2#VK#ZZ", lines: ["after"] },
      { op: "prepend", pos: "4#MB#ZZ", lines: ["before"] },
    ];

    expect(normalizeHashlineEdits(input)).toEqual([
      { op: "append", pos: "2#VK#ZZ", lines: ["after"] },
      { op: "prepend", pos: "4#MB#ZZ", lines: ["before"] },
    ]);
  });

  test("uses the end anchor as a fallback when pos is omitted for inserts", () => {
    const input: RawHashlineEdit[] = [{ op: "append", end: "3#VK#ZZ", lines: ["after"] }];

    expect(normalizeHashlineEdits(input)).toEqual([
      { op: "append", pos: "3#VK#ZZ", lines: ["after"] },
    ]);
  });

  test("accepts identical pos and end references for inserts", () => {
    const input: RawHashlineEdit[] = [
      { op: "prepend", pos: "3#VK#ZZ", end: "3#VK#ZZ", lines: ["before"] },
    ];

    expect(normalizeHashlineEdits(input)).toEqual([
      { op: "prepend", pos: "3#VK#ZZ", lines: ["before"] },
    ]);
  });

  test("treats pos and end that match after anchor trimming as non-conflicting", () => {
    const input: RawHashlineEdit[] = [
      { op: "append", pos: "  3#VK#ZZ ", end: "3#VK#ZZ", lines: ["after"] },
    ];

    expect(normalizeHashlineEdits(input)).toEqual([
      { op: "append", pos: "3#VK#ZZ", lines: ["after"] },
    ]);
  });

  test("rejects conflicting pos and end references for inserts", () => {
    const input: RawHashlineEdit[] = [
      { op: "prepend", pos: "3#VK#ZZ", end: "7#MB#ZZ", lines: ["before"] },
    ];

    expect(() => normalizeHashlineEdits(input)).toThrow(/conflicting pos and end/i);
  });

  test("allows an unanchored append for boundary insertion and file creation", () => {
    expect(normalizeHashlineEdits([{ op: "append", lines: ["tail"] }])).toEqual([
      { op: "append", lines: ["tail"] },
    ]);
    expect(normalizeHashlineEdits([{ op: "prepend", lines: ["head"] }])).toEqual([
      { op: "prepend", lines: ["head"] },
    ]);
  });

  test("converts null lines to empty array for append", () => {
    const input: RawHashlineEdit[] = [{ op: "append", pos: "2#VK#ZZ", lines: null }];

    expect(normalizeHashlineEdits(input)).toEqual([{ op: "append", pos: "2#VK#ZZ", lines: [] }]);
  });

  test("rejects edits that omit lines through the shared closed shape", () => {
    const input: RawHashlineEdit[] = [{ op: "replace", pos: "2#VK#ZZ" }];

    expect(() => normalizeHashlineEdits(input)).toThrow(/edits\[0\]\.lines/);
  });

  test("rejects unknown properties in a direct edit entry instead of stripping them", () => {
    const input = [
      { op: "append", pos: "2#VK#ZZ", lines: ["after"], typo: true },
    ] as unknown as RawHashlineEdit[];

    expect(() => normalizeHashlineEdits(input)).toThrow(/edits\[0\]\.typo/);
  });

  test("rejects malformed provided optional types in a direct edit entry", () => {
    expect(() =>
      normalizeHashlineEdits([
        { op: "append", pos: 7, lines: ["x"] },
      ] as unknown as RawHashlineEdit[]),
    ).toThrow(/edits\[0\]\.pos/);
    expect(() =>
      normalizeHashlineEdits([
        { op: "append", end: 7, lines: ["x"] },
      ] as unknown as RawHashlineEdit[]),
    ).toThrow(/edits\[0\]\.end/);
    expect(() =>
      normalizeHashlineEdits([{ op: "append", lines: 5 }] as unknown as RawHashlineEdit[]),
    ).toThrow(/edits\[0\]\.lines/);
    expect(() =>
      normalizeHashlineEdits([{ op: "append", lines: ["ok", 5] }] as unknown as RawHashlineEdit[]),
    ).toThrow(/edits\[0\]\.lines\[1\]/);
  });

  test("rejects a provided-but-blank optional anchor instead of treating it as absent", () => {
    expect(() => normalizeHashlineEdits([{ op: "append", pos: "   ", lines: ["x"] }])).toThrow(
      /pos was provided but is blank/,
    );
    expect(() => normalizeHashlineEdits([{ op: "prepend", end: "", lines: ["x"] }])).toThrow(
      /end was provided but is blank/,
    );
    // An omitted anchor is still a legal boundary insertion.
    expect(normalizeHashlineEdits([{ op: "append", lines: ["x"] }])).toEqual([
      { op: "append", lines: ["x"] },
    ]);
  });

  test("rejects unsupported operations", () => {
    const input = [
      { op: "set_line", pos: "2#VK#ZZ", lines: "updated" },
    ] as unknown as RawHashlineEdit[];

    expect(() => normalizeHashlineEdits(input)).toThrow(/unsupported op/);
  });
  test("rejects array payload entries containing embedded newlines", () => {
    const input: RawHashlineEdit[] = [{ op: "append", pos: "2#VK#ZZ", lines: ["a\nb"] }];

    expect(() => normalizeHashlineEdits(input)).toThrow(/embedded newline/);
  });

  test("rejects carriage returns inside array payload entries", () => {
    const input: RawHashlineEdit[] = [
      { op: "replace_range", pos: "2#VK#ZZ", end: "4#MB#ZZ", lines: ["a\rb"] },
    ];

    expect(() => normalizeHashlineEdits(input)).toThrow(/embedded newline/);
  });

  test("rejects blank-only replace payloads with teaching guidance", () => {
    const input: RawHashlineEdit[] = [{ op: "replace", pos: "2#VK#ZZ", lines: [""] }];

    expect(() => normalizeHashlineEdits(input)).toThrow(/ambiguous/);
    expect(() => normalizeHashlineEdits(input)).toThrow(/lines: \[\]/);
  });

  test("rejects blank-only replace_range payloads", () => {
    const input: RawHashlineEdit[] = [
      { op: "replace_range", pos: "2#VK#ZZ", end: "4#MB#ZZ", lines: [""] },
    ];

    expect(() => normalizeHashlineEdits(input)).toThrow(/ambiguous/);
  });

  test("rejects blank string payloads for replace", () => {
    const input: RawHashlineEdit[] = [{ op: "replace", pos: "2#VK#ZZ", lines: "" }];

    expect(() => normalizeHashlineEdits(input)).toThrow(/ambiguous/);
  });

  test("rejects replace string payloads with embedded newlines but no end", () => {
    const input: RawHashlineEdit[] = [{ op: "replace", pos: "2#VK#ZZ", lines: "a\nb" }];

    expect(() => normalizeHashlineEdits(input)).toThrow(/no end anchor/i);
  });

  test("accepts replace string payloads with embedded newlines when end is present", () => {
    const input: RawHashlineEdit[] = [
      { op: "replace", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: "a\nb" },
    ];

    expect(normalizeHashlineEdits(input)).toEqual([
      { op: "replace_range", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: "a\nb" },
    ]);
  });

  test("still accepts empty-array and null payloads as deletions", () => {
    expect(normalizeHashlineEdits([{ op: "replace", pos: "2#VK#ZZ", lines: [] }])).toEqual([
      { op: "replace", pos: "2#VK#ZZ", lines: [] },
    ]);
    expect(
      normalizeHashlineEdits([
        { op: "replace_range", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: null },
      ]),
    ).toEqual([{ op: "replace_range", pos: "2#VK#ZZ", end: "3#MB#ZZ", lines: [] }]);
  });

  test("allows blank lines inside insert payloads", () => {
    expect(normalizeHashlineEdits([{ op: "append", pos: "2#VK#ZZ", lines: [""] }])).toEqual([
      { op: "append", pos: "2#VK#ZZ", lines: [""] },
    ]);
  });
});
