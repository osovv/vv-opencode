// FILE: src/plugins/hashline-edit.validation.test.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify hashline reference parsing and validation diagnostics.
//   SCOPE: Valid reference parsing, malformed reference failures, copied-anchor normalization, legacy hash acceptance, mismatch context, and line-number suggestion hints.
//   DEPENDS: [bun:test, src/plugins/hashline-edit/hash-computation.ts, src/plugins/hashline-edit/validation.ts]
//   LINKS: [V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   hashline validation tests - Verify parsing and mismatch diagnostics for hashline anchors.
// END_MODULE_MAP

import { describe, expect, test } from "bun:test";
import { computeLegacyLineHash, computeLineHash } from "./hashline-edit/hash-computation.js";
import { parseLineRef, validateLineRef, validateLineRefs } from "./hashline-edit/validation.js";

describe("hashline validation", () => {
  test("parses a valid line reference", () => {
    expect(parseLineRef("42#VK")).toEqual({ line: 42, hash: "VK", anchorHash: undefined });
  });

  test("rejects invalid reference format", () => {
    expect(() => parseLineRef("42:VK")).toThrow(/\{line_number\}#\{hash_id\}/);
  });

  test("rejects non-numeric line prefixes with a clear hint", () => {
    expect(() => parseLineRef("LINE#HK")).toThrow(/not a line number/i);
  });

  test("accepts copied references with markers and trailing content", () => {
    expect(parseLineRef(">>> 42#VK|const value = 1")).toEqual({
      line: 42,
      hash: "VK",
      anchorHash: undefined,
    });
  });

  test("accepts references with spaces around the hash separator", () => {
    expect(parseLineRef("42 # VK")).toEqual({ line: 42, hash: "VK", anchorHash: undefined });
  });

  test("accepts legacy hashes for whitespace-variant content", () => {
    const lines = ["if (a && b) {"];
    const legacyHash = computeLegacyLineHash(1, "if(a&&b){");

    expect(() => validateLineRef(lines, `1#${legacyHash}`)).not.toThrow();
  });

  test("shows mismatch context with >>> markers for batched validation", () => {
    const lines = ["one", "two", "three", "four"];

    expect(() => validateLineRefs(lines, ["2#ZZ"])).toThrow(
      />>>\s+2#[ZPMQVRWSNKTXJBYH]{2}#[ZPMQVRWSNKTXJBYH]{2}\|two/,
    );
  });

  test("suggests the correct line number when the hash matches a current line", () => {
    const lines = ["function hello() {", "  return 42", "}"];
    const hash = computeLineHash(1, lines[0] ?? "");

    expect(() => validateLineRefs(lines, [`LINE#${hash}`])).toThrow(new RegExp(`1#${hash}`));
  });
});
