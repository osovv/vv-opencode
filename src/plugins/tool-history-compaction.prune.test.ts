// FILE: src/plugins/tool-history-compaction.prune.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Test the deterministic head/marker/tail prune engine: threshold behavior, surrogate safety, marker idempotence, and min-savings guard.
//   SCOPE: pruneOutput, alreadyCompacted, countCodePoints, codePointSlice.
//   DEPENDS: [src/plugins/tool-history-compaction/prune.ts, src/plugins/tool-history-compaction/config.ts]
//   LINKS: [V-M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   config - Module-local test fixture/helper.
//   BIG_TEXT - Module-local test fixture/helper.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Initial prune engine tests.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TOOL_HISTORY_COMPACTION,
  type ToolHistoryCompactionConfig,
} from "./tool-history-compaction/config.js";
import {
  PRUNE_MARKER,
  alreadyCompacted,
  codePointSlice,
  countCodePoints,
  pruneOutput,
} from "./tool-history-compaction/prune.js";

function config(overrides: Partial<ToolHistoryCompactionConfig> = {}): ToolHistoryCompactionConfig {
  return { ...DEFAULT_TOOL_HISTORY_COMPACTION, ...overrides };
}

const BIG_TEXT = "a".repeat(10_000);

describe("code-point helpers", () => {
  test("countCodePoints counts code points, not UTF-16 units", () => {
    // U+1F600 (surrogate pair) counts as one code point
    expect(countCodePoints("😀")).toBe(1);
    expect(countCodePoints("abc😀def")).toBe(7);
  });

  test("codePointSlice never splits a surrogate pair", () => {
    const text = "😀abc";
    const sliced = codePointSlice(text, 0, 2);
    expect(sliced).toBe("😀a");
    expect(Array.from(sliced).length).toBe(2);
  });
});

describe("pruneOutput", () => {
  test("over-threshold text becomes head + marker + tail, strictly smaller", () => {
    const result = pruneOutput(BIG_TEXT, config({ headChars: 100, tailChars: 40 }));
    expect(result).not.toBeNull();
    const { output, savings } = result!;
    expect(output.startsWith("a".repeat(100))).toBe(true);
    expect(output.endsWith("a".repeat(40))).toBe(true);
    expect(output).toContain(PRUNE_MARKER);
    expect(savings).toBeGreaterThan(0);
    expect(countCodePoints(output)).toBeLessThan(countCodePoints(BIG_TEXT));
    expect(countCodePoints(output)).toBeLessThanOrEqual(100 + PRUNE_MARKER.length + 40);
  });

  test("under-threshold text is left untouched", () => {
    expect(pruneOutput("short", config())).toBeNull();
  });

  test("outputMaxChars 0 disables pruning", () => {
    expect(pruneOutput(BIG_TEXT, config({ outputMaxChars: 0 }))).toBeNull();
  });

  test("already-compacted output is skipped (idempotence)", () => {
    const first = pruneOutput(BIG_TEXT, config({ headChars: 100, tailChars: 40 }));
    const second = pruneOutput(first!.output, config({ headChars: 100, tailChars: 40 }));
    expect(second).toBeNull();
  });

  test("alreadyCompacted detects the marker", () => {
    expect(alreadyCompacted(`head${PRUNE_MARKER}tail`)).toBe(true);
    expect(alreadyCompacted("plain")).toBe(false);
  });

  test("min-savings guard skips near-threshold rewrites", () => {
    // output just over threshold → tiny savings → skipped under a large minSavingsChars
    const over = "x".repeat(2_050); // > 2048 default
    expect(pruneOutput(over, config({ minSavingsChars: 10_000 }))).toBeNull();
  });

  test("min-savings 0 allows any over-threshold rewrite", () => {
    const over = "x".repeat(2_050);
    expect(pruneOutput(over, config({ minSavingsChars: 0 }))).not.toBeNull();
  });

  test("determinism: same input yields identical output", () => {
    const a = pruneOutput(BIG_TEXT, config({ headChars: 100, tailChars: 40 }));
    const b = pruneOutput(BIG_TEXT, config({ headChars: 100, tailChars: 40 }));
    expect(a!.output).toBe(b!.output);
  });

  test("savedPath embeds a recoverable note in the marker", () => {
    const result = pruneOutput(
      BIG_TEXT,
      config({ headChars: 100, tailChars: 40 }),
      "/data/vvoc/tool-output/tool-call-1.txt",
    );
    expect(result).not.toBeNull();
    const { output } = result!;
    expect(output).toContain(PRUNE_MARKER);
    expect(output).toContain("/data/vvoc/tool-output/tool-call-1.txt");
    expect(countCodePoints(output)).toBeLessThan(countCodePoints(BIG_TEXT));
  });

  test("savedPath keeps the marker detectably compacted", () => {
    const result = pruneOutput(
      BIG_TEXT,
      config({ headChars: 100, tailChars: 40 }),
      "/data/vvoc/tool-output/tool-call-1.txt",
    );
    expect(alreadyCompacted(result!.output)).toBe(true);
  });

  test("savedPath output stays within the budget accounting for the note", () => {
    const result = pruneOutput(
      BIG_TEXT,
      config({ headChars: 100, tailChars: 40 }),
      "/data/vvoc/tool-output/tool-call-1.txt",
    );
    const noteLength = countCodePoints("/data/vvoc/tool-output/tool-call-1.txt");
    expect(countCodePoints(result!.output)).toBeLessThanOrEqual(
      100 + PRUNE_MARKER.length + noteLength + 40,
    );
  });
});
