// FILE: src/plugins/tool-history-compaction.transform.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Test the transform core with real SDK-shaped parts: protected tail, retention dispatch, read-slim, prune application, input/structure immutability, and idempotence.
//   SCOPE: compactMessages over ToolPart fixtures matching @opencode-ai/sdk ToolState shapes.
//   DEPENDS: [src/plugins/tool-history-compaction/transform.ts, src/plugins/tool-history-compaction/config.ts]
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
//   LAST_CHANGE: [v0.1.0 - Initial transform core tests on real SDK-shaped parts.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { Part } from "@opencode-ai/sdk";
import {
  DEFAULT_TOOL_HISTORY_COMPACTION,
  type ToolHistoryCompactionConfig,
} from "./tool-history-compaction/config.js";
import { PRUNE_MARKER } from "./tool-history-compaction/prune.js";
import { compactMessages } from "./tool-history-compaction/transform.js";

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

function message<T extends Part[]>(parts: T): { info: { id: string }; parts: T } {
  return { info: { id: `msg-${seq}` }, parts };
}

const BIG = "y".repeat(10_000);
const LONG_READ = "1| alpha\n2| beta\n3| gamma\n4| delta " + "z".repeat(3000) + "\n5| omega";

describe("compactMessages", () => {
  test("protects the last message entirely", () => {
    const parts = [
      toolPart("bash", BIG), // old, eligible
    ];
    const messages = [message([toolPart("bash", "recent")]), message(parts)];
    // newest message is the last entry
    const messagesWithNewest = [...messages, message([toolPart("read", BIG)])];
    compactMessages(messagesWithNewest, config({ protectLastCalls: 0 }));
    // the newest message's big read must be untouched; the older bash was pruned
    const newest = messagesWithNewest[messagesWithNewest.length - 1]!;
    expect(newest.parts[0]!.state.output).toBe(BIG);
    const older = messagesWithNewest[1]!;
    expect(older.parts[0]!.state.output).toContain(PRUNE_MARKER);
  });

  test("protects the last N completed calls outside the last message", () => {
    const old = message([toolPart("bash", BIG)]);
    const second = message([toolPart("bash", BIG)]);
    const third = message([toolPart("bash", BIG)]);
    const messages = [old, second, third, message([toolPart("bash", "tail")])];
    compactMessages(messages, config({ protectLastCalls: 2 }));
    // newest message: untouched; next 2 completed calls: untouched; oldest: pruned
    expect(messages[3]!.parts[0]!.state.output).toBe("tail");
    expect(messages[2]!.parts[0]!.state.output).toBe(BIG);
    expect(messages[1]!.parts[0]!.state.output).toBe(BIG);
    expect(messages[0]!.parts[0]!.state.output).toContain(PRUNE_MARKER);
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
    compactMessages(messages, config({ readSlim: true, protectLastCalls: 0 }));
    expect(messages[0]!.parts[0]!.state.output).toBe("[Read /repo/lib.ts, lines 1-5]");
  });

  test("read without recoverable file falls back to pruning, never fabricates", () => {
    const messages = [message([toolPart("read", BIG, {})]), message([toolPart("bash", "recent")])];
    compactMessages(messages, config({ readSlim: true, protectLastCalls: 0 }));
    const output = messages[0]!.parts[0]!.state.output as string;
    expect(output.startsWith("[Read ")).toBe(false);
    expect(output).toContain(PRUNE_MARKER);
  });

  test("readSlim off prunes old reads by size instead", () => {
    const messages = [
      message([toolPart("read", BIG, { filePath: "/repo/lib.ts" })]),
      message([toolPart("bash", "recent")]),
    ];
    compactMessages(messages, config({ readSlim: false, protectLastCalls: 0 }));
    expect(messages[0]!.parts[0]!.state.output).toContain(PRUNE_MARKER);
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
    compactMessages(messages, config({ minSavingsChars: 2000 }));
    expect(messages[0]!.parts[0]!.state.output).toBe("small output");
  });
});
