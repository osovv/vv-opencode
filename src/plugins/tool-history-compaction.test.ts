// FILE: src/plugins/tool-history-compaction.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify ToolHistoryCompactionPlugin registration: transform hook presence, disabled no-op, config-driven behavior, and end-to-end in-memory compaction on SDK-shaped parts.
//   SCOPE: Plugin registration, project vvoc config seeding, transform hook invocation, and mutation isolation.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/config-layers.ts, src/lib/vvoc-config.ts, src/plugins/tool-history-compaction/index.ts]
//   LINKS: [M-PLUGIN-TOOL-HISTORY-COMPACTION, V-M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   previousConfigHome - Preserved XDG_CONFIG_HOME for test cleanup.
//   createPluginInput - Builds an isolated OpenCode plugin input fixture.
//   FixtureToolPart - SDK-shaped completed tool part fixture type.
//   createToolPart - Builds an SDK-shaped completed tool part.
//   writeProjectVvocConfig - Seeds a project .vvoc/vvcoc.json overriding the plugin entry.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Initial plugin registration and transform behavior tests.]
// END_CHANGE_SUMMARY

import type { Part } from "@opencode-ai/sdk";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetVvocConfigForTests } from "../lib/config-layers.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";
import { ToolHistoryCompactionPlugin } from "./tool-history-compaction/index.js";
import { PRUNE_MARKER } from "./tool-history-compaction/prune.js";

const previousConfigHome = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  resetVvocConfigForTests();
  process.env.XDG_CONFIG_HOME = join(tmpdir(), `vvoc-thc-empty-config-${process.pid}`);
});

afterEach(() => {
  resetVvocConfigForTests();
  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
});

function createPluginInput(directory: string) {
  return {
    client: {} as never,
    project: {} as never,
    directory,
    worktree: directory,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  };
}
type FixtureToolPart = Part & {
  type: "tool";
  callID: string;
  tool: string;
  state: {
    status: "completed";
    input: Record<string, unknown>;
    output: string;
    time?: { compacted?: number };
  };
};

function createToolPart(tool: string, output: string): FixtureToolPart {
  return {
    id: `part-${tool}-${Math.random()}`,
    sessionID: "sess",
    messageID: "msg",
    type: "tool",
    callID: `call-${tool}`,
    tool,
    state: {
      status: "completed",
      input: { filePath: "/repo/lib.ts" },
      output,
      title: tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

async function writeProjectVvocConfig(directory: string, pluginsEntry: unknown): Promise<void> {
  const doc = JSON.parse(renderVvocConfig(createDefaultVvocConfig())) as {
    plugins: Record<string, unknown>;
  };
  doc.plugins["tool-history-compaction"] = pluginsEntry;
  await mkdir(join(directory, ".vvoc"), { recursive: true });
  await writeFile(
    join(directory, ".vvoc", "vvoc.json"),
    JSON.stringify(doc, null, 2) + "\n",
    "utf8",
  );
}

describe("ToolHistoryCompactionPlugin", () => {
  test("enabled plugin registers the transform hook", async () => {
    const directory = await mkdtemp(join(tmpdir(), "thc-hook-"));
    try {
      const plugin = await ToolHistoryCompactionPlugin(createPluginInput(directory));
      expect(typeof plugin["experimental.chat.messages.transform"]).toBe("function");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("disabled plugin registers no hooks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "thc-disabled-"));
    try {
      await writeProjectVvocConfig(directory, false);
      const plugin = await ToolHistoryCompactionPlugin(createPluginInput(directory));
      expect(plugin).toEqual({});
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("transform hook compacts only the in-memory copy, preserving inputs and structure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "thc-transform-"));
    try {
      await writeProjectVvocConfig(directory, {
        enabled: true,
        protectLastCalls: 0,
        protectRecentMessages: 0,
      });
      const plugin = await ToolHistoryCompactionPlugin(createPluginInput(directory));
      const hook = plugin["experimental.chat.messages.transform"]!;

      const oldRead = createToolPart("read", "1| alpha\n2| beta " + "z".repeat(3000));
      const oldBash = createToolPart("bash", "y".repeat(10_000));
      const recent = createToolPart("bash", "recent");
      const messages = [
        { info: { id: "m-old" }, parts: [oldRead, oldBash] },
        { info: { id: "m-recent" }, parts: [recent] },
      ];

      const inputBefore = JSON.stringify(oldRead.state.input);
      const callIDsBefore = [oldRead.callID, oldBash.callID, recent.callID];
      const output = { messages } as Parameters<typeof hook>[1];
      await hook({}, output);

      // recent call untouched; old bash pruned; old read slimmed to a header
      expect(recent.state.output).toBe("recent");
      expect(oldBash.state.output).toContain(PRUNE_MARKER);
      expect(oldRead.state.output).toBe("[Read /repo/lib.ts, lines 1-2]");
      // inputs and callIDs never change
      expect(JSON.stringify(oldRead.state.input)).toBe(inputBefore);
      expect([oldRead.callID, oldBash.callID, recent.callID]).toEqual(callIDsBefore);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("custom config from project vvoc.json drives behavior", async () => {
    const directory = await mkdtemp(join(tmpdir(), "thc-config-"));
    try {
      await writeProjectVvocConfig(directory, {
        enabled: true,
        readSlim: false,
        protectLastCalls: 0,
        protectRecentMessages: 0,
      });
      const plugin = await ToolHistoryCompactionPlugin(createPluginInput(directory));
      const hook = plugin["experimental.chat.messages.transform"]!;

      const oldRead = createToolPart("read", "1| alpha\n2| beta " + "z".repeat(6000));
      const messages = [
        { info: { id: "m-old" }, parts: [oldRead] },
        { info: { id: "m-recent" }, parts: [createToolPart("bash", "recent")] },
      ];
      await hook({}, { messages } as Parameters<typeof hook>[1]);

      // readSlim off: old read is pruned by size, not slimmed
      expect(oldRead.state.output.startsWith("[Read ")).toBe(false);
      expect(oldRead.state.output).toContain(PRUNE_MARKER);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
