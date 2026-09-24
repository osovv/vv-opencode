// FILE: src/plugins/hashline-edit/tool-description.test.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the LLM-facing edit-tool descriptions: hashline structural-insertion safety and literal payload semantics, and the str_replace_editor description surface.
//   SCOPE: Operation-choice guidance for adjacent insertions, consumed closing syntax, literal application, physical single-line entries, blank-payload rejection, post-edit diff verification, and the shared str_replace_editor description constant.
//   DEPENDS: [bun:test, src/plugins/hashline-edit/tool-description.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   [test scenarios] - Edit tool-description coverage is expressed through module-level tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-005 - Added coverage for the str_replace_editor description constant moved into this module.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { HASHLINE_EDIT_DESCRIPTION, STR_REPLACE_EDITOR_DESCRIPTION } from "./tool-description.js";

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

describe("STR_REPLACE_EDITOR_DESCRIPTION", () => {
  test("exposes the dsh command contract text", () => {
    expect(STR_REPLACE_EDITOR_DESCRIPTION).toContain("Custom editing tool for viewing");
    expect(STR_REPLACE_EDITOR_DESCRIPTION).toContain("`old_str` parameter should match EXACTLY");
    expect(STR_REPLACE_EDITOR_DESCRIPTION).toContain("<response clipped>");
  });
});
