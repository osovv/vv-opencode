// FILE: src/plugins/hashline-edit.tool-description.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the LLM-facing hashline edit contract directs structural insertions to safe operations.
//   SCOPE: Operation-choice guidance for adjacent insertions, consumed closing syntax, and session-derived closing-line regressions.
//   DEPENDS: [bun:test, src/plugins/hashline-edit/tool-description.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   HASHLINE_EDIT_DESCRIPTION tests - Preserve safety guidance for append/prepend and structural range replacements.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added regression coverage for operation guidance derived from real closing-line loss incidents.]
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
    expect(HASHLINE_EDIT_DESCRIPTION).toContain("Never assume autocorrect reconstructs omitted");
    expect(HASHLINE_EDIT_DESCRIPTION).toContain(
      "BAD - replacing a closing line only to insert after it",
    );
    expect(HASHLINE_EDIT_DESCRIPTION).toContain('CORRECT: { op: "append", pos: "13#QR#GH"');
    expect(HASHLINE_EDIT_DESCRIPTION).toContain('console.log(\\"hello\\");');
    expect(HASHLINE_EDIT_DESCRIPTION).toContain("</operations>");
  });
});
