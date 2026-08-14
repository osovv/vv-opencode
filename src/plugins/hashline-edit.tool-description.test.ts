// FILE: src/plugins/hashline-edit.tool-description.test.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the LLM-facing hashline edit contract directs structural insertions to safe operations and documents literal payload semantics.
//   SCOPE: Operation-choice guidance for adjacent insertions, consumed closing syntax, literal application, physical single-line entries, blank-payload rejection, and post-edit diff verification.
//   DEPENDS: [bun:test, src/plugins/hashline-edit/tool-description.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   [test scenarios] - Hashline tool-description coverage is expressed through module-level tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.0 - Added literal-application assertions and updated the closing-syntax wording after removing autocorrect promises.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { HASHLINE_EDIT_DESCRIPTION } from "./hashline-edit/tool-description.js";

describe("HASHLINE_EDIT_DESCRIPTION", () => {
  test("directs adjacent insertions away from replacing structural closing lines", () => {
    expect(HASHLINE_EDIT_DESCRIPTION).toContain("INSERTION SAFETY");
    expect(HASHLINE_EDIT_DESCRIPTION).toContain("append after its final structural closing line");
    expect(HASHLINE_EDIT_DESCRIPTION).toContain(
      "Do NOT replace that closing line merely to reproduce it",
    );
    expect(HASHLINE_EDIT_DESCRIPTION).toContain("Never assume the tool reconstructs omitted");
    expect(HASHLINE_EDIT_DESCRIPTION).toContain(
      "BAD - replacing a closing line only to insert after it",
    );
    expect(HASHLINE_EDIT_DESCRIPTION).toContain('CORRECT: { op: "append", pos: "13#QR#GH"');
    expect(HASHLINE_EDIT_DESCRIPTION).toContain('console.log(\\"hello\\");');
    expect(HASHLINE_EDIT_DESCRIPTION).toContain("</operations>");
  });

  test("documents literal application and reported echo trimming", () => {
    expect(HASHLINE_EDIT_DESCRIPTION).toContain("LITERAL APPLICATION");
    expect(HASHLINE_EDIT_DESCRIPTION).toContain("applied byte-for-byte");
    expect(HASHLINE_EDIT_DESCRIPTION).toContain(
      "Everything else is applied literally — no merging, splitting, or indentation fixes.",
    );
    expect(HASHLINE_EDIT_DESCRIPTION).toContain("reported as Warning lines");
  });

  test("documents physical single-line entries and blank-payload rejection", () => {
    expect(HASHLINE_EDIT_DESCRIPTION).toContain("PHYSICAL LINES");
    expect(HASHLINE_EDIT_DESCRIPTION).toContain("Entries with embedded newlines are rejected");
    expect(HASHLINE_EDIT_DESCRIPTION).toContain(
      'lines: [""] with replace/replace_range -> REJECTED',
    );
    expect(HASHLINE_EDIT_DESCRIPTION).toContain("append/prepend to insert blank lines");
  });

  test("directs the model to verify the post-edit diff summary", () => {
    expect(HASHLINE_EDIT_DESCRIPTION).toContain("VERIFY");
    expect(HASHLINE_EDIT_DESCRIPTION).toContain("bounded diff (@@ block)");
  });
});
