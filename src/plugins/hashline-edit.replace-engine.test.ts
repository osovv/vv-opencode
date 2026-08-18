// FILE: src/plugins/hashline-edit.replace-engine.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the replace profile engine: layered matching, uniqueness rules, teaching errors, and success formatting.
//   SCOPE: Exact layer, unicode-confusables layer with byte preservation, trailing-whitespace layer without indentation relaxation, replace-all mode, identical/empty payload rejection, ambiguity errors, and bounded diff output.
//   DEPENDS: [bun:test, src/plugins/hashline-edit/replace-engine.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   [test scenarios] - Replace engine coverage is expressed through module-level tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Initial replace engine coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { applyReplaceEdit, formatReplaceSuccess } from "./hashline-edit/replace-engine.js";

describe("replace engine exact layer", () => {
  test("applies an exact literal replacement", () => {
    const result = applyReplaceEdit("alpha\nbeta\ngamma\n", {
      oldString: "beta",
      newString: "BETA",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe("alpha\nBETA\ngamma\n");
    expect(result.layer).toBe("exact");
    expect(result.replacements).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  test("rejects zero matches with a teaching error", () => {
    const result = applyReplaceEdit("alpha\n", { oldString: "beta", newString: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("oldString not found");
    expect(result.error).toContain("Read tool");
  });

  test("rejects ambiguous matches with the occurrence count", () => {
    const result = applyReplaceEdit("dup\ndup\ndup\n", { oldString: "dup", newString: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("matches 3 locations");
    expect(result.error).toContain("replaceAll");
  });

  test("replace_all replaces every occurrence", () => {
    const result = applyReplaceEdit("dup\ndup\ndup\n", {
      oldString: "dup",
      newString: "x",
      replaceAll: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe("x\nx\nx\n");
    expect(result.replacements).toBe(3);
  });

  test("rejects identical old and new strings", () => {
    const result = applyReplaceEdit("alpha\n", { oldString: "alpha", newString: "alpha" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("identical");
  });

  test("rejects empty oldString on existing content", () => {
    const result = applyReplaceEdit("alpha\n", { oldString: "", newString: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("cannot be empty");
  });
});

describe("replace engine fallback layers", () => {
  test("matches curly quotes via unicode confusables and preserves original bytes elsewhere", () => {
    const content = "const msg = \u201Chello\u201D;\nconst keep = \u201Chello\u201D;\n";
    const result = applyReplaceEdit(content, {
      oldString: 'const msg = "hello";',
      newString: 'const msg = "bye";',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layer).toBe("unicode_confusables");
    expect(result.content).toBe('const msg = "bye";\nconst keep = \u201Chello\u201D;\n');
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("unicode confusables");
  });

  test("unicode confusables ambiguity is reported before applying", () => {
    const content = "\u201Csame\u201D\n\u201Csame\u201D\n";
    const result = applyReplaceEdit(content, { oldString: '"same"', newString: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("matches 2 locations");
  });

  test("matches when only trailing whitespace differs", () => {
    const content = "alpha   \nbeta\t\ngamma\n";
    const result = applyReplaceEdit(content, {
      oldString: "alpha\nbeta",
      newString: "ALPHA\nBETA",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layer).toBe("trailing_whitespace");
    expect(result.content).toBe("ALPHA\nBETA\ngamma\n");
    expect(result.warnings[0]).toContain("trailing whitespace");
  });

  test("fallback layers never relax leading whitespace (indentation)", () => {
    const content = "def foo():\n    return 1\n";
    const result = applyReplaceEdit(content, {
      oldString: "def foo():\nreturn 1",
      newString: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("oldString not found");
  });

  test("exact match wins over fallback layers without warnings", () => {
    const content = "plain\n";
    const result = applyReplaceEdit(content, { oldString: "plain", newString: "x" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layer).toBe("exact");
    expect(result.warnings).toEqual([]);
  });
});

describe("replace engine output formatting", () => {
  test("success output carries stats, warnings, and bounded diff", () => {
    const before = "one\ntwo\nthree\n";
    const result = applyReplaceEdit(before, { oldString: "two", newString: "TWO" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = formatReplaceSuccess("/tmp/file.ts", before, result);
    expect(output).toContain("Updated /tmp/file.ts (+1/-1, first change line 2)");
    expect(output).toContain("@@ changed lines 2 @@");
    expect(output).toContain("- two");
    expect(output).toContain("+ TWO");
  });

  test("fallback layer successes announce the layer", () => {
    const before = "alpha   \nbeta\n";
    const result = applyReplaceEdit(before, { oldString: "alpha\nbeta", newString: "ALPHA\nBETA" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = formatReplaceSuccess("/tmp/file.ts", before, result);
    expect(output).toContain("matched via trailing_whitespace fallback layer");
    expect(output).toContain("Warning:");
  });
});
