// FILE: src/plugins/tool-history-compaction.transform.test.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Test the transform core with real SDK-shaped parts: recency-time recent-message window, retained-tool budget fix, retention dispatch, read-slim, prune application, recoverable saved-output markers, input/structure immutability, and idempotence.
//   SCOPE: compactMessages and recentMessageIndexes over ToolPart fixtures matching @opencode-ai/sdk ToolState shapes.
//   DEPENDS: [src/plugins/tool-history-compaction/transform.ts, src/plugins/tool-history-compaction/config.ts, src/plugins/tool-history-compaction/prune.ts]
//   LINKS: [V-M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   config - Module-local test fixture/helper.
//   seq - Module-local test fixture/helper.
//   ToolPartFixture - Module-local test fixture/helper.
//   toolPart - Module-local test fixture/helper.
//   message - Module-local test fixture/helper.
//   BIG - Module-local test fixture/helper.
//   LONG_READ - Module-local test fixture/helper.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.0 - Added recency-time window tests, retained-budget regression, and recoverable saved-output markers.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { Part } from "@opencode-ai/sdk";
import {
  DEFAULT_TOOL_HISTORY_COMPACTION,
  type ToolHistoryCompactionConfig,
} from "./tool-history-compaction/config.js";
import { PRUNE_MARKER, SAVED_OUTPUT_NOTE_PREFIX } from "./tool-history-compaction/prune.js";
import { recentMessageIndexes, compactMessages } from "./tool-history-compaction/transform.js";

function config(overrides: Partial<ToolHistoryCompactionConfig> = {}): ToolHistoryCompactionConfig {
  return { ...DEFAULT_TOOL_HISTORY_COMPACTION, ...overrides };
}

let seq = 0;

type ToolPartFixture = Part & {
  type: "tool";
  callID: string;
  tool: string;
  state: {
    status: "completed" | "error";
    input: Record<string, unknown>;
    output?: string;
    error?: string;
    time?: { start: number; end: number; compacted?: number };
  };
};

function toolPart(
  tool: string,
  output: string,
  input: Record<string, unknown> = {},
  options: { status?: "completed" | "error"; compacted?: boolean } = {},
): ToolPartFixture {
  seq += 1;
  return {
    id: `part-${seq}`,
    sessionID: "sess",
    messageID: "msg",
    type: "tool",
    callID: `call-${seq}`,
    tool,
    state:
      options.status === "error"
        ? { status: "error", input, error: "boom", time: { start: 1, end: 2 } }
        : {
            status: "completed",
            input,
            output,
            title: tool,
            metadata: {},
            time: {
              start: 1,
              end: 2,
              ...(options.compacted ? { compacted: 3 } : {}),
            },
          },
  };
}

function message<T extends ToolPartFixture[]>(
  parts: T,
  options: { time?: { created?: number; completed?: number }; id?: string } = {},
): { info: { id: string; time?: { created?: number; completed?: number } }; parts: T } {
  seq += 1;
  return {
    info: { id: options.id ?? `msg-${seq}`, ...(options.time ? { time: options.time } : {}) },
    parts,
  };
}

const BIG = "y".repeat(10_000);
const LONG_READ = "1| alpha\n2| beta\n3| gamma\n4| delta " + "z".repeat(3000) + "\n5| omega";

describe("recentMessageIndexes", () => {
  test("returns the newest messages by recency time regardless of array order", () => {
    const messages = [
      message([toolPart("bash", "a")], { time: { created: 100 } }),
      message([toolPart("bash", "b")], { time: { created: 300 } }),
      message([toolPart("bash", "c")], { time: { created: 200 } }),
    ];
    const result = recentMessageIndexes(messages, 2);
    expect(result).toEqual(new Set([1, 2]));
  });

  test("completed time wins over created time", () => {
    // a has completed 700 (newest); b has only created 600 — completed must rank higher.
    const messages = [
      message([toolPart("bash", "a")], { time: { created: 500, completed: 700 } }),
      message([toolPart("bash", "b")], { time: { created: 600 } }),
    ];
    const result = recentMessageIndexes(messages, 1);
    expect(result).toEqual(new Set([0]));
  });

  test("messages without times fall back to array-position ordering", () => {
    const messages = [
      message([toolPart("bash", "a")]),
      message([toolPart("bash", "b")]),
      message([toolPart("bash", "c")]),
    ];
    const result = recentMessageIndexes(messages, 2);
    expect(result).toEqual(new Set([1, 2]));
  });

  test("zero or negative count disables the window", () => {
    const messages = [message([toolPart("bash", "a")]), message([toolPart("bash", "b")])];
    expect(recentMessageIndexes(messages, 0)).toEqual(new Set());
    expect(recentMessageIndexes(messages, -1)).toEqual(new Set());
  });
});

describe("compactMessages", () => {
  test("protects the entire recent message window regardless of size and call count", () => {
    // Ten messages; window of 8 protects all but the oldest two.
    const messages: ReturnType<typeof message>[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(
        message([toolPart("bash", BIG), toolPart("read", BIG, { filePath: `/repo/f${i}.ts` })]),
      );
    }
    compactMessages(messages, config({ protectRecentMessages: 8, protectLastCalls: 0 }));
    // Oldest two messages (indices 0 and 1) are compacted; newest 8 are untouched.
    expect(messages[0]!.parts[0]!.state.output).toContain(PRUNE_MARKER);
    expect(messages[1]!.parts[0]!.state.output).toContain(PRUNE_MARKER);
    for (let i = 2; i < 10; i++) {
      expect(messages[i]!.parts[0]!.state.output).toBe(BIG);
      expect(messages[i]!.parts[1]!.state.output).toBe(BIG);
    }
  });

  test("recent window survives message reordering by recency time", () => {
    // Six messages with ascending times stored out of order; window of 4 must
    // protect the four newest by time (indices of times 300,400,500,600).
    const messages = [
      message([toolPart("bash", BIG)], { time: { created: 600 } }),
      message([toolPart("bash", BIG)], { time: { created: 100 } }),
      message([toolPart("bash", BIG)], { time: { created: 500 } }),
      message([toolPart("bash", BIG)], { time: { created: 200 } }),
      message([toolPart("bash", BIG)], { time: { created: 400 } }),
      message([toolPart("bash", BIG)], { time: { created: 300 } }),
    ];
    compactMessages(messages, config({ protectRecentMessages: 4, protectLastCalls: 0 }));
    // Oldest two by time (100, 200) are pruned; newest four untouched.
    const outputs = messages.map((m) => m.parts[0]!.state.output);
    expect(outputs.filter((o) => o === BIG)).toHaveLength(4);
    expect(outputs.filter((o) => o !== BIG)).toHaveLength(2);
  });

  test("protects the last N completed calls outside the recent window", () => {
    const old = message([toolPart("bash", BIG)]);
    const second = message([toolPart("bash", BIG)]);
    const third = message([toolPart("bash", BIG)]);
    const tail = message([toolPart("bash", "tail")]);
    const messages = [old, second, third, tail];
    // Window off; per-call protection of 2 outside the last message.
    compactMessages(messages, config({ protectRecentMessages: 0, protectLastCalls: 2 }));
    expect(messages[3]!.parts[0]!.state.output).toBe("tail");
    expect(messages[2]!.parts[0]!.state.output).toBe(BIG);
    expect(messages[1]!.parts[0]!.state.output).toBe(BIG);
    expect(messages[0]!.parts[0]!.state.output).toContain(PRUNE_MARKER);
  });

  test("retained tools outside the window do not consume the per-call protection budget", () => {
    // Two retained task parts then one old bash part. Budget 1 must be reserved
    // for the bash part, proving retained tools no longer drain protection.
    const oldBash = message([toolPart("bash", BIG)]);
    const retained1 = message([toolPart("task", "subagent report")]);
    const retained2 = message([toolPart("webfetch", "web content")]);
    const tail = message([toolPart("bash", "tail")]);
    const messages = [oldBash, retained1, retained2, tail];
    compactMessages(messages, config({ protectRecentMessages: 0, protectLastCalls: 1 }));
    // Newest bash protected; retained protected; oldest bash protected by the
    // budget that retained parts no longer consume.
    expect(messages[3]!.parts[0]!.state.output).toBe("tail");
    expect(messages[2]!.parts[0]!.state.output).toBe("web content");
    expect(messages[1]!.parts[0]!.state.output).toBe("subagent report");
    expect(messages[0]!.parts[0]!.state.output).toBe(BIG);
  });

  test("retained tools are never compacted regardless of size", () => {
    const messages = [
      message([toolPart("webfetch", "x".repeat(50_000))]),
      message([toolPart("bash", "recent")]),
    ];
    compactMessages(messages, config());
    expect((messages[0]!.parts[0]!.state.output as string).length).toBe(50_000);
  });

  test("old read outputs collapse to a header with a recovered range", () => {
    const messages = [
      message([toolPart("read", LONG_READ, { filePath: "/repo/lib.ts" })]),
      message([toolPart("bash", "recent")]),
    ];
    compactMessages(
      messages,
      config({ readSlim: true, protectRecentMessages: 0, protectLastCalls: 0 }),
    );
    expect(messages[0]!.parts[0]!.state.output).toBe("[Read /repo/lib.ts, lines 1-5]");
  });

  test("read without recoverable file falls back to pruning, never fabricates", () => {
    const messages = [message([toolPart("read", BIG, {})]), message([toolPart("bash", "recent")])];
    compactMessages(
      messages,
      config({ readSlim: true, protectRecentMessages: 0, protectLastCalls: 0 }),
    );
    const output = messages[0]!.parts[0]!.state.output as string;
    expect(output.startsWith("[Read ")).toBe(false);
    expect(output).toContain(PRUNE_MARKER);
  });

  test("readSlim off prunes old reads by size instead", () => {
    const messages = [
      message([toolPart("read", BIG, { filePath: "/repo/lib.ts" })]),
      message([toolPart("bash", "recent")]),
    ];
    compactMessages(
      messages,
      config({ readSlim: false, protectRecentMessages: 0, protectLastCalls: 0 }),
    );
    expect(messages[0]!.parts[0]!.state.output).toContain(PRUNE_MARKER);
  });

  test("prune with savePrunedOutput embeds the persisted path in the marker", () => {
    const messages = [message([toolPart("bash", BIG)]), message([toolPart("bash", "recent")])];
    compactMessages(
      messages,
      config({ protectRecentMessages: 0, protectLastCalls: 0, savePrunedOutput: true }),
    );
    const output = messages[0]!.parts[0]!.state.output as string;
    expect(output).toContain(PRUNE_MARKER);
    expect(output).toContain(SAVED_OUTPUT_NOTE_PREFIX);
  });

  test("prune with savePrunedOutput off keeps a plain head/marker/tail marker", () => {
    const messages = [message([toolPart("bash", BIG)]), message([toolPart("bash", "recent")])];
    compactMessages(
      messages,
      config({ protectRecentMessages: 0, protectLastCalls: 0, savePrunedOutput: false }),
    );
    const output = messages[0]!.parts[0]!.state.output as string;
    expect(output).toContain(PRUNE_MARKER);
    expect(output).not.toContain(SAVED_OUTPUT_NOTE_PREFIX);
  });

  test("readSlim markers never embed a saved-output path", () => {
    const messages = [
      message([toolPart("read", LONG_READ, { filePath: "/repo/lib.ts" })]),
      message([toolPart("bash", "recent")]),
    ];
    compactMessages(
      messages,
      config({ readSlim: true, protectRecentMessages: 0, protectLastCalls: 0 }),
    );
    expect(messages[0]!.parts[0]!.state.output).toBe("[Read /repo/lib.ts, lines 1-5]");
  });

  test("error parts are never touched", () => {
    const messages = [
      message([toolPart("bash", BIG, {}, { status: "error" })]),
      message([toolPart("bash", "recent")]),
    ];
    compactMessages(messages, config());
    expect(messages[0]!.parts[0]!.state).toMatchObject({ status: "error" });
  });

  test("OpenCode-compacted parts are skipped", () => {
    const messages = [
      message([toolPart("bash", "[Old tool result content cleared]", {}, { compacted: true })]),
      message([toolPart("bash", "recent")]),
    ];
    compactMessages(messages, config());
    expect(messages[0]!.parts[0]!.state.output).toBe("[Old tool result content cleared]");
  });

  test("inputs, callID, tool, and ordering are never changed", () => {
    const input = { filePath: "/repo/a.ts" };
    const parts = [toolPart("read", BIG, input), toolPart("bash", BIG, { command: "ls" })];
    const callIDs = parts.map((p) => p.callID);
    const tools = parts.map((p) => p.tool);
    const inputBefore = JSON.stringify(parts[0]!.state.input);
    const messages = [message(parts), message([toolPart("bash", "recent")])];
    compactMessages(messages, config());
    expect(parts.map((p) => p.callID)).toEqual(callIDs);
    expect(parts.map((p) => p.tool)).toEqual(tools);
    expect(JSON.stringify(parts[0]!.state.input)).toBe(inputBefore);
  });

  test("idempotence: second pass changes nothing", () => {
    const messages = [
      message([toolPart("read", LONG_READ, { filePath: "/repo/lib.ts" }), toolPart("bash", BIG)]),
      message([toolPart("bash", "recent")]),
    ];
    compactMessages(messages, config());
    const afterFirst = JSON.stringify(messages);
    compactMessages(messages, config());
    expect(JSON.stringify(messages)).toBe(afterFirst);
  });

  test("small outputs are untouched by the savings guard", () => {
    const messages = [
      message([toolPart("bash", "small output")]),
      message([toolPart("bash", "recent")]),
    ];
    compactMessages(
      messages,
      config({ minSavingsChars: 2000, protectRecentMessages: 0, protectLastCalls: 0 }),
    );
    expect(messages[0]!.parts[0]!.state.output).toBe("small output");
  });
});
