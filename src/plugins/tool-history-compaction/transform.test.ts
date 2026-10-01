// FILE: src/plugins/tool-history-compaction/transform.test.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Test the native transform core with pinned real @opencode/ai representations: id-bearing assistant rows with tool calls followed by id-less Message.tool(result) children, logical source-message grouping, correlated recency windows, retained-tool budget, retention dispatch, read-slim from the native call input, prune application, recoverable saved-output markers, opaque/unknown fail-safe preservation, input/structure immutability, and idempotence.
//   SCOPE: compactMessages and recentMessageIndexes over native AI message fixtures including the split multi-call representation emitted by core/session/runner/to-llm-message.ts.
//   DEPENDS: [bun:test, @opencode/ai, src/plugins/tool-history-compaction/transform.ts, src/plugins/tool-history-compaction/config.ts, src/plugins/tool-history-compaction/prune.ts]
//   LINKS: [M-PLUGIN-TOOL-HISTORY-COMPACTION, V-M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   previousDataHome - Preserves the caller's data-home environment for cleanup.
//   scratchDataHome - Tracks the isolated data home created by the test.
//   config - Module-local test fixture/helper.
//   seq - Monotonic counter making generated fixture ids unique.
//   nextId - Build a unique fixture id from a prefix.
//   ResultType - Native tool-result result-type union used by the result-part fixture.
//   resultPart - Builds a native tool-result part.
//   callPart - Builds a native tool-call part.
//   assistantRow - Builds an id-bearing native assistant row.
//   toolChild - Builds an id-less native Message.tool(result) child.
//   soloResult - Builds an id-bearing assistant row carrying one result.
//   outputAt - Reads the first native tool-result text value.
//   inputAt - Reads the first native tool-call input.
//   timesOf - Builds a native message-id recency map.
//   BIG - Module-local test fixture/helper.
//   LONG_READ - Module-local test fixture/helper.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-006 attempt 2 - Replaced nearest-preceding recency inheritance with real call/source logical grouping over the pinned split multi-call representation, plus unknown-correlation fail-safe preservation.]
// END_CHANGE_SUMMARY

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Message, ToolCallPart, ToolResultPart, type ContentPart } from "@opencode/ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TOOL_HISTORY_COMPACTION, type ToolHistoryCompactionConfig } from "./config.js";
import { PRUNE_MARKER, SAVED_OUTPUT_NOTE_PREFIX } from "./prune.js";
import { recentMessageIndexes, compactMessages } from "./transform.js";

const previousDataHome = process.env.XDG_DATA_HOME;
let scratchDataHome = "";

beforeAll(() => {
  scratchDataHome = mkdtempSync(join(tmpdir(), "vvoc-thc-data-"));
  process.env.XDG_DATA_HOME = scratchDataHome;
});

afterAll(() => {
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  if (scratchDataHome) rmSync(scratchDataHome, { recursive: true, force: true });
});

function config(overrides: Partial<ToolHistoryCompactionConfig> = {}): ToolHistoryCompactionConfig {
  return { ...DEFAULT_TOOL_HISTORY_COMPACTION, ...overrides };
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

type ResultType = "text" | "json" | "error" | "content";

function resultPart(
  id: string,
  tool: string,
  output: unknown,
  resultType: ResultType = "text",
): ToolResultPart {
  return ToolResultPart.make({ id, name: tool, result: output, resultType });
}

function callPart(id: string, tool: string, input: Record<string, unknown> = {}): ToolCallPart {
  return ToolCallPart.make({ id, name: tool, input });
}

/** An id-bearing native assistant row (one logical source message). */
function assistantRow(id: string, content: ContentPart[]): Message {
  return Message.make({ id, role: "assistant", content });
}

/** An id-less `Message.tool(result)` child exactly as the native translator emits it. */
function toolChild(result: ToolResultPart): Message {
  return Message.tool(result);
}

/** An id-bearing assistant row carrying one textual result. */
function soloResult(tool: string, output: unknown, id = nextId("m")): Message {
  return assistantRow(id, [resultPart(nextId("call"), tool, output)]);
}

/** The pinned split representation: one id-bearing call row plus id-less result children. */
function outputAt(message: Message): unknown {
  for (const part of message.content) {
    if (part.type === "tool-result") return (part.result as { value?: unknown }).value;
  }
  return undefined;
}

function inputAt(message: Message): unknown {
  for (const part of message.content) {
    if (part.type === "tool-call") return part.input;
  }
  return undefined;
}

function timesOf(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

const BIG = "y".repeat(10_000);
const LONG_READ = "1: alpha\n2: beta\n3: gamma\n4: delta " + "z".repeat(3000) + "\n5: omega";

describe("recentMessageIndexes", () => {
  test("returns the newest logical messages by correlated recency time regardless of array order", () => {
    const messages = [
      soloResult("bash", "a", "m0"),
      soloResult("bash", "b", "m1"),
      soloResult("bash", "c", "m2"),
    ];
    const result = recentMessageIndexes(messages, 2, timesOf({ m0: 100, m1: 300, m2: 200 }));
    expect(result).toEqual(new Set([1, 2]));
  });

  test("messages without a correlated time fall back to array-position ordering", () => {
    const messages = [soloResult("bash", "a"), soloResult("bash", "b"), soloResult("bash", "c")];
    const result = recentMessageIndexes(messages, 2, new Map());
    expect(result).toEqual(new Set([1, 2]));
  });

  test("id-less result children group into their one id-bearing source message", () => {
    // Exact shape from core/session/runner/to-llm-message.ts: one assistant row
    // with two calls, then two id-less Message.tool(result) children.
    const source = assistantRow("newest", [callPart("c1", "bash"), callPart("c2", "read")]);
    const messages = [
      source,
      toolChild(resultPart("c1", "bash", BIG)),
      toolChild(resultPart("c2", "read", LONG_READ)),
    ];
    const result = recentMessageIndexes(messages, 1, timesOf({ newest: 200 }));
    expect(result).toEqual(new Set([0, 1, 2]));
  });

  test("rows whose source identity cannot be resolved are always protected", () => {
    const messages = [
      soloResult("bash", "a", "m0"),
      toolChild(resultPart("orphan", "bash", BIG)),
      soloResult("bash", "c", "m2"),
    ];
    const result = recentMessageIndexes(messages, 1, timesOf({ m0: 100, m2: 500 }));
    expect(result.has(1)).toBe(true);
    expect(result).toEqual(new Set([1, 2]));
  });

  test("zero or negative count disables the window", () => {
    const messages = [soloResult("bash", "a"), soloResult("bash", "b")];
    expect(recentMessageIndexes(messages, 0)).toEqual(new Set());
    expect(recentMessageIndexes(messages, -1)).toEqual(new Set());
  });
});

describe("compactMessages", () => {
  test("the pinned split multi-call source row protects both id-less result children", () => {
    const messages = [
      assistantRow("newest", [
        callPart("c1", "bash"),
        callPart("c2", "read", { path: "/repo/lib.ts" }),
      ]),
      toolChild(resultPart("c1", "bash", BIG)),
      toolChild(resultPart("c2", "read", LONG_READ)),
    ];
    compactMessages(
      messages,
      config({ protectRecentMessages: 1, protectLastCalls: 0, savePrunedOutput: false }),
      timesOf({ newest: 200 }),
    );
    expect(outputAt(messages[1]!)).toBe(BIG);
    expect(outputAt(messages[2]!)).toBe(LONG_READ);
  });

  test("protects the entire recent logical window regardless of size and call count", () => {
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(
        assistantRow(`m${i}`, [
          resultPart(nextId("call"), "bash", BIG),
          callPart(nextId("call"), "read", { path: `/repo/f${i}.ts` }),
        ]),
      );
    }
    compactMessages(
      messages,
      config({ protectRecentMessages: 8, protectLastCalls: 0, savePrunedOutput: false }),
    );
    // Oldest two logical messages are compacted; newest 8 are untouched.
    expect(outputAt(messages[0]!)).toContain(PRUNE_MARKER);
    expect(outputAt(messages[1]!)).toContain(PRUNE_MARKER);
    for (let i = 2; i < 10; i++) {
      expect(outputAt(messages[i]!)).toBe(BIG);
    }
  });

  test("recent window survives out-of-order source times with N>1", () => {
    const messages = [
      assistantRow("a", [resultPart("a1", "bash", BIG)]),
      toolChild(resultPart("a1", "bash", BIG)),
      assistantRow("b", [resultPart("b1", "bash", BIG)]),
      toolChild(resultPart("b1", "bash", BIG)),
    ];
    const times = timesOf({ a: 100, b: 300 });
    compactMessages(
      messages,
      config({ protectRecentMessages: 1, protectLastCalls: 0, savePrunedOutput: false }),
      times,
    );
    // Source "b" is newest: its own row and id-less child stay; source "a" is compacted.
    expect(outputAt(messages[1]!)).toContain(PRUNE_MARKER);
    expect(outputAt(messages[3]!)).toBe(BIG);
  });

  test("an unresolvable result child is never compacted even when its neighbors are", () => {
    const messages = [
      soloResult("bash", BIG, "m0"),
      toolChild(resultPart("orphan", "bash", BIG)),
      soloResult("bash", BIG, "m2"),
    ];
    compactMessages(
      messages,
      config({ protectRecentMessages: 1, protectLastCalls: 0, savePrunedOutput: false }),
      timesOf({ m0: 100, m2: 500 }),
    );
    // m2 is the protected newest logical message; orphan is fail-safe protected;
    // m0 is compacted.
    expect(outputAt(messages[0]!)).toContain(PRUNE_MARKER);
    expect(outputAt(messages[1]!)).toBe(BIG);
    expect(outputAt(messages[2]!)).toBe(BIG);
  });

  test("protects the last N completed calls outside the recent window", () => {
    const messages = [
      soloResult("bash", BIG, "m0"),
      soloResult("bash", BIG, "m1"),
      soloResult("bash", BIG, "m2"),
      soloResult("bash", "tail", "m3"),
    ];
    compactMessages(
      messages,
      config({ protectRecentMessages: 0, protectLastCalls: 2, savePrunedOutput: false }),
    );
    expect(outputAt(messages[3]!)).toBe("tail");
    expect(outputAt(messages[2]!)).toBe(BIG);
    expect(outputAt(messages[1]!)).toBe(BIG);
    expect(outputAt(messages[0]!)).toContain(PRUNE_MARKER);
  });

  test("retained tools outside the window do not consume the per-call protection budget", () => {
    const messages = [
      soloResult("bash", BIG, "m0"),
      soloResult("task", "subagent report", "m1"),
      soloResult("webfetch", "web content", "m2"),
      soloResult("bash", "tail", "m3"),
    ];
    compactMessages(
      messages,
      config({ protectRecentMessages: 0, protectLastCalls: 1, savePrunedOutput: false }),
    );
    expect(outputAt(messages[3]!)).toBe("tail");
    expect(outputAt(messages[2]!)).toBe("web content");
    expect(outputAt(messages[1]!)).toBe("subagent report");
    expect(outputAt(messages[0]!)).toBe(BIG);
  });

  test("retained tools are never compacted regardless of size", () => {
    const messages = [
      soloResult("webfetch", "x".repeat(50_000), "m0"),
      soloResult("bash", "recent", "m1"),
    ];
    compactMessages(messages, config({ savePrunedOutput: false }));
    expect((outputAt(messages[0]!) as string).length).toBe(50_000);
  });

  test("native websearch results stay retained through the shared search substring", () => {
    const messages = [
      soloResult("websearch", "x".repeat(50_000), "m0"),
      soloResult("bash", "recent", "m1"),
    ];
    compactMessages(messages, config({ savePrunedOutput: false }));
    expect((outputAt(messages[0]!) as string).length).toBe(50_000);
  });

  test("old read outputs collapse to a header with a range recovered from the native call input", () => {
    const messages = [
      assistantRow("m0", [
        callPart("r1", "read", { path: "/repo/lib.ts" }),
        resultPart("r1", "read", LONG_READ),
      ]),
      soloResult("bash", "recent", "m1"),
    ];
    compactMessages(
      messages,
      config({
        readSlim: true,
        protectRecentMessages: 0,
        protectLastCalls: 0,
        savePrunedOutput: false,
      }),
    );
    expect(outputAt(messages[0]!)).toBe("[Read /repo/lib.ts, lines 1-5]");
  });

  test("read without a recoverable file falls back to pruning, never fabricates", () => {
    const messages = [
      assistantRow("m0", [callPart("r1", "read", {}), resultPart("r1", "read", BIG)]),
      soloResult("bash", "recent", "m1"),
    ];
    compactMessages(
      messages,
      config({
        readSlim: true,
        protectRecentMessages: 0,
        protectLastCalls: 0,
        savePrunedOutput: false,
      }),
    );
    const output = outputAt(messages[0]!) as string;
    expect(output.startsWith("[Read ")).toBe(false);
    expect(output).toContain(PRUNE_MARKER);
  });

  test("readSlim off prunes old reads by size instead", () => {
    const messages = [
      assistantRow("m0", [
        callPart("r1", "read", { path: "/repo/lib.ts" }),
        resultPart("r1", "read", BIG),
      ]),
      soloResult("bash", "recent", "m1"),
    ];
    compactMessages(
      messages,
      config({
        readSlim: false,
        protectRecentMessages: 0,
        protectLastCalls: 0,
        savePrunedOutput: false,
      }),
    );
    expect(outputAt(messages[0]!)).toContain(PRUNE_MARKER);
  });

  test("prune with savePrunedOutput embeds the persisted path in the marker", () => {
    const messages = [soloResult("bash", BIG, "m0"), soloResult("bash", "recent", "m1")];
    compactMessages(
      messages,
      config({ protectRecentMessages: 0, protectLastCalls: 0, savePrunedOutput: true }),
    );
    const output = outputAt(messages[0]!) as string;
    expect(output).toContain(PRUNE_MARKER);
    expect(output).toContain(SAVED_OUTPUT_NOTE_PREFIX);
  });

  test("prune with savePrunedOutput off keeps a plain head/marker/tail marker", () => {
    const messages = [soloResult("bash", BIG, "m0"), soloResult("bash", "recent", "m1")];
    compactMessages(
      messages,
      config({ protectRecentMessages: 0, protectLastCalls: 0, savePrunedOutput: false }),
    );
    const output = outputAt(messages[0]!) as string;
    expect(output).toContain(PRUNE_MARKER);
    expect(output).not.toContain(SAVED_OUTPUT_NOTE_PREFIX);
  });

  test("error, json, and content results are never touched", () => {
    const messages = [
      assistantRow("m0", [
        resultPart(nextId("call"), "bash", "y".repeat(50_000), "json"),
        resultPart(nextId("call"), "bash", "y".repeat(50_000), "content"),
        resultPart(nextId("call"), "bash", "boom", "error"),
      ]),
      soloResult("bash", "recent", "m1"),
    ];
    compactMessages(
      messages,
      config({ savePrunedOutput: false, protectRecentMessages: 0, protectLastCalls: 0 }),
    );
    const types = messages[0]!.content.map((part) => (part as ToolResultPart).result.type);
    expect(types).toEqual(["json", "content", "error"]);
  });

  test("opaque non-tool context parts are never touched and remain fail-safe", () => {
    const opaque = Message.make({ id: "opaque", role: "user", content: [Message.text("keep me")] });
    const messages = [opaque, soloResult("bash", BIG, "m0"), soloResult("bash", "recent", "m1")];
    compactMessages(
      messages,
      config({ savePrunedOutput: false, protectRecentMessages: 0, protectLastCalls: 0 }),
    );
    expect(opaque.content[0]).toEqual({ type: "text", text: "keep me" });
    expect(outputAt(messages[1]!)).toContain(PRUNE_MARKER);
  });

  test("already-pruned text is skipped (idempotence marker)", () => {
    const messages = [
      soloResult("bash", `head${PRUNE_MARKER}tail`, "m0"),
      soloResult("bash", "recent", "m1"),
    ];
    compactMessages(
      messages,
      config({ protectRecentMessages: 0, protectLastCalls: 0, savePrunedOutput: false }),
    );
    expect(outputAt(messages[0]!)).toBe(`head${PRUNE_MARKER}tail`);
  });

  test("part ids, names, inputs, content order, and message ids are never changed", () => {
    const readInput = { path: "/repo/a.ts" };
    const messages = [
      assistantRow("m0", [callPart("r1", "read", readInput), resultPart("r1", "read", BIG)]),
      soloResult("bash", "recent", "m1"),
    ];
    const target = messages[0]!;
    const callIdBefore = (target.content[0] as ToolCallPart).id;
    const resultIdBefore = (target.content[1] as ToolResultPart).id;
    const messageIdBefore = target.id;
    const inputBefore = JSON.stringify(inputAt(target));

    compactMessages(messages, config({ savePrunedOutput: false }));

    expect((target.content[0] as ToolCallPart).id).toBe(callIdBefore);
    expect((target.content[1] as ToolResultPart).id).toBe(resultIdBefore);
    expect((target.content[1] as ToolResultPart).name).toBe("read");
    expect(JSON.stringify(inputAt(target))).toBe(inputBefore);
    expect(target.id).toBe(messageIdBefore);
    expect((target.content[0] as ToolCallPart).type).toBe("tool-call");
    expect((target.content[1] as ToolResultPart).type).toBe("tool-result");
    expect(target.content).toHaveLength(2);
  });

  test("idempotence: second pass changes nothing", () => {
    const messages = [
      assistantRow("m0", [
        callPart("r1", "read", { path: "/repo/lib.ts" }),
        resultPart("r1", "read", LONG_READ),
      ]),
      soloResult("bash", "recent", "m1"),
    ];
    compactMessages(messages, config({ savePrunedOutput: false }));
    const afterFirst = JSON.stringify(messages);
    compactMessages(messages, config({ savePrunedOutput: false }));
    expect(JSON.stringify(messages)).toBe(afterFirst);
  });

  test("small outputs are untouched by the savings guard", () => {
    const messages = [soloResult("bash", "small output", "m0"), soloResult("bash", "recent", "m1")];
    compactMessages(
      messages,
      config({
        minSavingsChars: 2000,
        protectRecentMessages: 0,
        protectLastCalls: 0,
        savePrunedOutput: false,
      }),
    );
    expect(outputAt(messages[0]!)).toBe("small output");
  });
});
