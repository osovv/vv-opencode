// FILE: src/plugins/tool-history-compaction.config.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Test strict tool-history-compaction config parsing, defaults, budget invariants, and entry union resolution.
//   SCOPE: Config vocabulary, validation failures, and boolean-or-object entry parsing.
//   DEPENDS: [src/plugins/tool-history-compaction/config.ts, src/plugins/tool-history-compaction/retention.ts]
//   LINKS: [V-M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   describe/expect/test - Bun test harness assertions; no module-level helpers.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Initial config and retention tests.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TOOL_HISTORY_COMPACTION,
  DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY,
  parseToolHistoryCompactionEntry,
  resolveConfig,
} from "./tool-history-compaction/config.js";
import { DEFAULT_RETAIN_TOOLS, isRetainedTool } from "./tool-history-compaction/retention.js";
import { PRUNE_MARKER } from "./tool-history-compaction/prune.js";

describe("config defaults", () => {
  test("undefined entry resolves to enabled with defaults", () => {
    const entry = parseToolHistoryCompactionEntry(undefined);
    expect(entry.enabled).toBe(true);
    expect(entry.config).toEqual(DEFAULT_TOOL_HISTORY_COMPACTION);
  });

  test("defaults match the materializable entry", () => {
    expect(DEFAULT_TOOL_HISTORY_COMPACTION.protectLastCalls).toBe(
      DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY.protectLastCalls,
    );
    expect(DEFAULT_TOOL_HISTORY_COMPACTION.protectRecentMessages).toBe(
      DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY.protectRecentMessages,
    );
    expect(DEFAULT_TOOL_HISTORY_COMPACTION.savePrunedOutput).toBe(
      DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY.savePrunedOutput,
    );
    expect(DEFAULT_TOOL_HISTORY_COMPACTION.protectRecentMessages).toBe(8);
    expect(DEFAULT_TOOL_HISTORY_COMPACTION.savePrunedOutput).toBe(true);
    expect(DEFAULT_TOOL_HISTORY_COMPACTION.readSlim).toBe(true);
    expect(DEFAULT_TOOL_HISTORY_COMPACTION.outputMaxChars).toBe(2048);
    expect(DEFAULT_TOOL_HISTORY_COMPACTION.headChars).toBe(1200);
    expect(DEFAULT_TOOL_HISTORY_COMPACTION.tailChars).toBe(400);
    expect(DEFAULT_TOOL_HISTORY_COMPACTION.minSavingsChars).toBe(2000);
  });

  test("default retain list covers web fetch/search/skill/subagent families", () => {
    expect(DEFAULT_RETAIN_TOOLS).toContain("webfetch");
    expect(DEFAULT_RETAIN_TOOLS).toContain("search");
    expect(DEFAULT_RETAIN_TOOLS).toContain("skill");
    expect(DEFAULT_RETAIN_TOOLS).toContain("task");
  });
});

describe("entry union parsing", () => {
  test("boolean true and false resolve enabled accordingly", () => {
    expect(parseToolHistoryCompactionEntry(true).enabled).toBe(true);
    expect(parseToolHistoryCompactionEntry(false).enabled).toBe(false);
  });

  test("object form keeps enabled and resolves partial config against defaults", () => {
    const entry = parseToolHistoryCompactionEntry({ enabled: false, readSlim: false });
    expect(entry.enabled).toBe(false);
    expect(entry.config.readSlim).toBe(false);
    expect(entry.config.protectLastCalls).toBe(DEFAULT_TOOL_HISTORY_COMPACTION.protectLastCalls);
  });

  test("non-boolean, non-object entries fail loudly", () => {
    expect(() => parseToolHistoryCompactionEntry(42)).toThrow(/boolean or an object/);
    expect(() => parseToolHistoryCompactionEntry("yes")).toThrow(/boolean or an object/);
  });

  test("enabled must be a boolean", () => {
    expect(() => parseToolHistoryCompactionEntry({ enabled: "yes" })).toThrow(
      /enabled must be a boolean/,
    );
  });
});

describe("config validation", () => {
  test("unknown keys fail loudly", () => {
    expect(() => resolveConfig({ outputMaxChars: 1000, bogus: true })).toThrow(
      /unknown config key/,
    );
  });

  test("protectRecentMessages and savePrunedOutput validate strictly", () => {
    expect(resolveConfig({ protectRecentMessages: 4 }).protectRecentMessages).toBe(4);
    expect(resolveConfig({ savePrunedOutput: false }).savePrunedOutput).toBe(false);
    expect(() => resolveConfig({ protectRecentMessages: -1 })).toThrow(/non-negative integer/);
    expect(() => resolveConfig({ protectRecentMessages: 1.5 })).toThrow(/non-negative integer/);
    expect(() => resolveConfig({ savePrunedOutput: "yes" })).toThrow(/must be a boolean/);
  });

  test("negative or non-integer budgets fail loudly", () => {
    expect(() => resolveConfig({ outputMaxChars: -1 })).toThrow(/non-negative integer/);
    expect(() => resolveConfig({ minSavingsChars: 1.5 })).toThrow(/non-negative integer/);
    expect(() => resolveConfig({ headChars: "100" })).toThrow(/non-negative integer/);
  });

  test("budgets must fit within outputMaxChars", () => {
    expect(() => resolveConfig({ outputMaxChars: 10, headChars: 9, tailChars: 9 })).toThrow(
      /must fit within outputMaxChars/,
    );
  });

  test("outputMaxChars 0 disables pruning and skips the fit check", () => {
    const config = resolveConfig({ outputMaxChars: 0 });
    expect(config.outputMaxChars).toBe(0);
  });

  test("retainTools must be an array of non-empty strings", () => {
    expect(() => resolveConfig({ retainTools: "search" })).toThrow(/array of non-empty strings/);
    expect(() => resolveConfig({ retainTools: [""] })).toThrow(/non-empty strings/);
  });

  test("budget invariant holds for the default marker length", () => {
    const config = DEFAULT_TOOL_HISTORY_COMPACTION;
    expect(config.headChars + config.tailChars + PRUNE_MARKER.length).toBeLessThanOrEqual(
      config.outputMaxChars,
    );
  });
});

describe("retention classification", () => {
  test("default list matches knowledge tools case-insensitively", () => {
    expect(isRetainedTool("webfetch", DEFAULT_RETAIN_TOOLS)).toBe(true);
    expect(isRetainedTool("WebFetch", DEFAULT_RETAIN_TOOLS)).toBe(true);
    expect(isRetainedTool("brave-search_brave_web_search", DEFAULT_RETAIN_TOOLS)).toBe(true);
    expect(isRetainedTool("web-search-prime_web_search_prime", DEFAULT_RETAIN_TOOLS)).toBe(true);
    expect(isRetainedTool("web-reader_webReader", DEFAULT_RETAIN_TOOLS)).toBe(true);
    expect(isRetainedTool("skill", DEFAULT_RETAIN_TOOLS)).toBe(true);
    expect(isRetainedTool("task", DEFAULT_RETAIN_TOOLS)).toBe(true);
  });

  test("ephemeral tools are not retained by default", () => {
    expect(isRetainedTool("read", DEFAULT_RETAIN_TOOLS)).toBe(false);
    expect(isRetainedTool("bash", DEFAULT_RETAIN_TOOLS)).toBe(false);
    expect(isRetainedTool("grep", DEFAULT_RETAIN_TOOLS)).toBe(false);
    expect(isRetainedTool("edit", DEFAULT_RETAIN_TOOLS)).toBe(false);
  });

  test("empty or undefined tool names never match", () => {
    expect(isRetainedTool(undefined, DEFAULT_RETAIN_TOOLS)).toBe(false);
    expect(isRetainedTool("", DEFAULT_RETAIN_TOOLS)).toBe(false);
  });

  test("custom retain lists override the default", () => {
    expect(isRetainedTool("read", ["read"])).toBe(true);
    expect(isRetainedTool("read", ["custom"])).toBe(false);
  });
});
