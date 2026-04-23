// FILE: src/plugins/hashline-edit.normalize-edits.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify raw hashline edit normalization into typed operations.
//   SCOPE: Replace normalization, anchored append/prepend normalization, anchor precedence, required-lines failures, null-line rejection for inserts, and unsupported-op failures.
//   DEPENDS: [bun:test, src/plugins/hashline-edit/normalize-edits.ts]
//   LINKS: [V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   hashline normalize-edits tests - Verify tool payload normalization and validation failures.
// END_MODULE_MAP

import { describe, expect, test } from "bun:test";
import { normalizeHashlineEdits, type RawHashlineEdit } from "./hashline-edit/normalize-edits.js";

describe("hashline normalize-edits", () => {
  test("maps replace with pos to a replace edit", () => {
    const input: RawHashlineEdit[] = [{ op: "replace", pos: "2#VK", lines: "updated" }];

    expect(normalizeHashlineEdits(input)).toEqual([
      { op: "replace", pos: "2#VK", lines: "updated" },
    ]);
  });

  test("maps replace with pos and end to a ranged replace edit", () => {
    const input: RawHashlineEdit[] = [
      { op: "replace", pos: "2#VK", end: "4#MB", lines: ["a", "b"] },
    ];

    expect(normalizeHashlineEdits(input)).toEqual([
      { op: "replace", pos: "2#VK", end: "4#MB", lines: ["a", "b"] },
    ]);
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

  test("rejects append with lines=null", () => {
    const input: RawHashlineEdit[] = [{ op: "append", pos: "2#VK", lines: null }];

    expect(() => normalizeHashlineEdits(input)).toThrow(/does not support lines=null/);
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
});
