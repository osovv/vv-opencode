// FILE: src/plugins/tool-history-compaction.read-slim.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Test old-read collapse: file alias recovery, line-range recovery from OpenCode and hashline outputs, fail-closed fallbacks, savings guard, and input immutability.
//   SCOPE: fileFromReadInput, rangeFromReadOutput, slimReadOutput.
//   DEPENDS: [src/plugins/tool-history-compaction/read-slim.ts, src/plugins/tool-history-compaction/config.ts]
//   LINKS: [V-M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   opencodeReadOutput - Module-local test fixture/helper.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Initial read-slim tests.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { DEFAULT_TOOL_HISTORY_COMPACTION } from "./tool-history-compaction/config.js";
import {
  fileFromReadInput,
  rangeFromReadOutput,
  slimReadOutput,
} from "./tool-history-compaction/read-slim.js";

function opencodeReadOutput(first: number, last: number, lineCount: number): string {
  const lines: string[] = [];
  for (let n = first; n <= last && n < first + lineCount; n++) {
    lines.push(`${n}| content ${n} ${"x".repeat(80)}`);
  }
  return lines.join("\n");
}

describe("fileFromReadInput", () => {
  test("recovers filePath, path, and file aliases", () => {
    expect(fileFromReadInput({ filePath: "/a/b.ts" })).toBe("/a/b.ts");
    expect(fileFromReadInput({ path: "/c/d.ts" })).toBe("/c/d.ts");
    expect(fileFromReadInput({ file: "/e/f.ts" })).toBe("/e/f.ts");
  });

  test("unknown or missing input yields undefined", () => {
    expect(fileFromReadInput(undefined)).toBeUndefined();
    expect(fileFromReadInput({})).toBeUndefined();
    expect(fileFromReadInput({ filePath: 42 })).toBeUndefined();
  });
});

describe("rangeFromReadOutput", () => {
  test("recovers range from OpenCode pipe output", () => {
    expect(rangeFromReadOutput(opencodeReadOutput(1, 42, 42))).toBe("1-42");
  });

  test("recovers range from hashline anchored output", () => {
    const anchored = ["1#AB#CD|line one", "2#EF#GH|line two", "3#IJ#KL|line three"].join("\n");
    expect(rangeFromReadOutput(anchored)).toBe("1-3");
  });

  test("non-line-numbered output yields undefined (fail-closed)", () => {
    expect(rangeFromReadOutput("just plain text\nno numbers here")).toBeUndefined();
    expect(rangeFromReadOutput(undefined)).toBeUndefined();
  });
});

describe("slimReadOutput", () => {
  test("slims an old read with file and range", () => {
    const input = { filePath: "/repo/src/lib.ts" };
    const output = opencodeReadOutput(10, 60, 51);
    const result = slimReadOutput(input, output, DEFAULT_TOOL_HISTORY_COMPACTION);
    expect(result).not.toBeNull();
    expect(result!.output).toBe("[Read /repo/src/lib.ts, lines 10-60]");
    expect(result!.savings).toBeGreaterThan(0);
  });

  test("omits the range when it cannot be recovered, still slims", () => {
    const input = { filePath: "/repo/plain.txt" };
    const output =
      "plain content that is long enough to clear the savings guard " + "x".repeat(3000);
    const result = slimReadOutput(input, output, DEFAULT_TOOL_HISTORY_COMPACTION);
    expect(result!.output).toBe("[Read /repo/plain.txt]");
  });

  test("missing file falls back (null) instead of fabricating", () => {
    expect(
      slimReadOutput({}, "long content " + "x".repeat(3000), DEFAULT_TOOL_HISTORY_COMPACTION),
    ).toBeNull();
  });

  test("already slimmed output is skipped (idempotence)", () => {
    const input = { filePath: "/repo/lib.ts" };
    const slimmed = "[Read /repo/lib.ts, lines 10-60]";
    expect(slimReadOutput(input, slimmed, DEFAULT_TOOL_HISTORY_COMPACTION)).toBeNull();
  });

  test("savings guard skips small reads", () => {
    const input = { filePath: "/repo/small.ts" };
    // Output too small to clear the default min-savings guard.
    expect(slimReadOutput(input, "tiny", DEFAULT_TOOL_HISTORY_COMPACTION)).toBeNull();
  });

  test("input is never mutated", () => {
    const input = { filePath: "/repo/lib.ts", oldString: "a" };
    const frozen = Object.freeze({ ...input });
    const output = opencodeReadOutput(1, 40, 40);
    slimReadOutput(frozen, output, DEFAULT_TOOL_HISTORY_COMPACTION);
    expect(frozen.filePath).toBe("/repo/lib.ts");
    expect(frozen.oldString).toBe("a");
  });
});
