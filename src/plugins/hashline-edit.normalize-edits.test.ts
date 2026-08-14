// FILE: src/plugins/hashline-edit.normalize-edits.test.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify raw hashline edit normalization into typed operations.
//   SCOPE: Replace normalization, anchored append/prepend normalization, anchor precedence, required-lines failures, null-to-empty-array conversion for inserts, unsupported-op failures, embedded-newline entry rejection, and blank-only replacement rejection.
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
//   LAST_CHANGE: [v0.4.0 - Added coverage rejecting embedded newlines in array entries and blank-only replace/replace_range payloads.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { normalizeHashlineEdits, type RawHashlineEdit } from "./hashline-edit/normalize-edits.js";

describe("hashline normalize-edits", () => {
  test("maps replace with pos to a replace edit", () => {
    const input: RawHashlineEdit[] = [{ op: "replace", pos: "2#VK", lines: "updated" }];

    expect(normalizeHashlineEdits(input)).toEqual([
      { op: "replace", pos: "2#VK", lines: "updated" },
    ]);
  });

  test("maps replace_range with pos and end to a ranged replace edit", () => {
    const input: RawHashlineEdit[] = [
      { op: "replace_range", pos: "2#VK", end: "4#MB", lines: ["a", "b"] },
    ];

    expect(normalizeHashlineEdits(input)).toEqual([
      { op: "replace_range", pos: "2#VK", end: "4#MB", lines: ["a", "b"] },
    ]);
  });

  test("rejects replace with end", () => {
    const input: RawHashlineEdit[] = [{ op: "replace", pos: "2#VK", end: "4#MB", lines: ["a"] }];

    expect(() => normalizeHashlineEdits(input)).toThrow(/replace does not accept end/i);
  });

  test("rejects replace_range without end", () => {
    const input: RawHashlineEdit[] = [{ op: "replace_range", pos: "2#VK", lines: ["a"] }];

    expect(() => normalizeHashlineEdits(input)).toThrow(/requires both pos and end/i);
  });

  test("rejects replace with multi-line lines payload", () => {
    const input: RawHashlineEdit[] = [{ op: "replace", pos: "2#VK", lines: ["line1", "line2"] }];

    expect(() => normalizeHashlineEdits(input)).toThrow(/single-line replacement only/i);
  });

  test("maps anchored append and prepend while preserving op", () => {
    const input: RawHashlineEdit[] = [
      { op: "append", pos: "2#VK", lines: ["after"] },
      { op: "prepend", pos: "4#MB", lines: ["before"] },
    ];

    expect(normalizeHashlineEdits(input)).toEqual([
      { op: "append", pos: "2#VK", lines: ["after"] },
      { op: "prepend", pos: "4#MB", lines: ["before"] },
    ]);
  });

  test("prefers pos over end when both anchors are present for inserts", () => {
    const input: RawHashlineEdit[] = [
      { op: "prepend", pos: "3#AA", end: "7#BB", lines: ["before"] },
    ];

    expect(normalizeHashlineEdits(input)).toEqual([
      { op: "prepend", pos: "3#AA", lines: ["before"] },
    ]);
  });

  test("converts null lines to empty array for append", () => {
    const input: RawHashlineEdit[] = [{ op: "append", pos: "2#VK", lines: null }];

    expect(normalizeHashlineEdits(input)).toEqual([{ op: "append", pos: "2#VK", lines: [] }]);
  });

  test("rejects edits that omit lines", () => {
    const input: RawHashlineEdit[] = [{ op: "replace", pos: "2#VK" }];

    expect(() => normalizeHashlineEdits(input)).toThrow(/lines is required/);
  });

  test("rejects unsupported operations", () => {
    const input = [
      { op: "set_line", pos: "2#VK", lines: "updated" },
    ] as unknown as RawHashlineEdit[];

    expect(() => normalizeHashlineEdits(input)).toThrow(/unsupported op/);
  });
  test("rejects array payload entries containing embedded newlines", () => {
    const input: RawHashlineEdit[] = [{ op: "append", pos: "2#VK", lines: ["a\nb"] }];

    expect(() => normalizeHashlineEdits(input)).toThrow(/embedded newline/);
  });

  test("rejects carriage returns inside array payload entries", () => {
    const input: RawHashlineEdit[] = [
      { op: "replace_range", pos: "2#VK", end: "4#MB", lines: ["a\rb"] },
    ];

    expect(() => normalizeHashlineEdits(input)).toThrow(/embedded newline/);
  });

  test("rejects blank-only replace payloads with teaching guidance", () => {
    const input: RawHashlineEdit[] = [{ op: "replace", pos: "2#VK", lines: [""] }];

    expect(() => normalizeHashlineEdits(input)).toThrow(/ambiguous/);
    expect(() => normalizeHashlineEdits(input)).toThrow(/lines: \[\]/);
  });

  test("rejects blank-only replace_range payloads", () => {
    const input: RawHashlineEdit[] = [
      { op: "replace_range", pos: "2#VK", end: "4#MB", lines: [""] },
    ];

    expect(() => normalizeHashlineEdits(input)).toThrow(/ambiguous/);
  });

  test("rejects blank string payloads for replace", () => {
    const input: RawHashlineEdit[] = [{ op: "replace", pos: "2#VK", lines: "" }];

    expect(() => normalizeHashlineEdits(input)).toThrow(/ambiguous/);
  });

  test("rejects replace string payloads with embedded newlines", () => {
    const input: RawHashlineEdit[] = [{ op: "replace", pos: "2#VK", lines: "a\nb" }];

    expect(() => normalizeHashlineEdits(input)).toThrow(/replace_range/);
  });

  test("still accepts empty-array and null payloads as deletions", () => {
    expect(normalizeHashlineEdits([{ op: "replace", pos: "2#VK", lines: [] }])).toEqual([
      { op: "replace", pos: "2#VK", lines: [] },
    ]);
    expect(
      normalizeHashlineEdits([{ op: "replace_range", pos: "2#VK", end: "3#MB", lines: null }]),
    ).toEqual([{ op: "replace_range", pos: "2#VK", end: "3#MB", lines: [] }]);
  });

  test("allows blank lines inside insert payloads", () => {
    expect(normalizeHashlineEdits([{ op: "append", pos: "2#VK", lines: [""] }])).toEqual([
      { op: "append", pos: "2#VK", lines: [""] },
    ]);
  });
});
