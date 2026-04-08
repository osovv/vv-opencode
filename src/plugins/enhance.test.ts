// FILE: src/plugins/enhance.test.ts
// VERSION: 0.1.1
// START_MODULE_CONTRACT
//   PURPOSE: Verify `/enhance` runtime prompt rewrite behavior.
//   SCOPE: Command hook interception, TUI clear+append success path, and fallback behavior when TUI APIs fail.
//   DEPENDS: [bun:test, src/plugins/enhance/index.ts]
//   LINKS: [V-M-PLUGIN-ENHANCE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   EnhanceCommandPlugin tests - Verify `/enhance` rewrites the current TUI prompt and falls back safely when rewrite fails.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.1 - Added coverage for partial-failure draft restoration and missing-TUI-method fallback.]
// END_CHANGE_SUMMARY

import { expect, test } from "bun:test";
import { EnhanceCommandPlugin } from "./enhance/index.js";

function createPluginContext(overrides?: {
  clearPromptError?: unknown;
  appendPromptError?: unknown;
  clearPromptThrows?: boolean;
  appendPromptThrows?: boolean;
  missingClearPrompt?: boolean;
}) {
  const calls: Array<{ method: string; input: unknown }> = [];

  const clearPrompt = overrides?.missingClearPrompt
    ? undefined
    : async (input: unknown) => {
        calls.push({ method: "clearPrompt", input });
        if (overrides?.clearPromptThrows) {
          throw new Error("clear failed");
        }
        return { error: overrides?.clearPromptError };
      };

  const appendPrompt = async (input: unknown) => {
    calls.push({ method: "appendPrompt", input });
    if (overrides?.appendPromptThrows) {
      throw new Error("append failed");
    }
    return { error: overrides?.appendPromptError };
  };

  const pluginInput = {
    client: {
      tui: {
        clearPrompt,
        appendPrompt,
        showToast: async (input: unknown) => {
          calls.push({ method: "showToast", input });
          return {};
        },
      },
    } as never,
    project: {} as never,
    directory: "/tmp/project",
    worktree: "/tmp/project",
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  };

  return { calls, pluginInput };
}

test("EnhanceCommandPlugin rewrites /enhance into the TUI prompt", async () => {
  const { calls, pluginInput } = createPluginContext();
  const plugin = await EnhanceCommandPlugin(pluginInput);

  const output = {
    parts: [
      {
        type: "text",
        text: '<vvoc_enhance version="1.0">...</vvoc_enhance>',
      },
    ],
  };

  await plugin["command.execute.before"]?.(
    {
      command: "enhance",
      sessionID: "session-1",
      arguments: "fix tests",
    },
    output as never,
  );

  expect(output.parts).toEqual([]);
  expect(calls.map((entry) => entry.method)).toEqual(["clearPrompt", "appendPrompt", "showToast"]);
  expect(calls[1]?.input).toEqual({
    query: { directory: "/tmp/project" },
    body: { text: '<vvoc_enhance version="1.0">...</vvoc_enhance>' },
  });
});

test("EnhanceCommandPlugin falls back when TUI prompt rewrite fails", async () => {
  const { calls, pluginInput } = createPluginContext({ appendPromptError: { message: "failed" } });
  const plugin = await EnhanceCommandPlugin(pluginInput);

  const output = {
    parts: [{ type: "text", text: "fallback prompt" }],
  };

  await plugin["command.execute.before"]?.(
    {
      command: "enhance",
      sessionID: "session-1",
      arguments: "fix tests",
    },
    output as never,
  );

  expect(output.parts).toEqual([{ type: "text", text: "fallback prompt" }]);
  expect(calls.map((entry) => entry.method)).toEqual([
    "clearPrompt",
    "appendPrompt",
    "appendPrompt",
    "showToast",
  ]);
  expect(calls[2]?.input).toEqual({
    query: { directory: "/tmp/project" },
    body: { text: "/enhance fix tests" },
  });
});

test("EnhanceCommandPlugin falls back when clearPrompt throws", async () => {
  const { calls, pluginInput } = createPluginContext({ clearPromptThrows: true });
  const plugin = await EnhanceCommandPlugin(pluginInput);

  const output = {
    parts: [{ type: "text", text: "fallback prompt" }],
  };

  await plugin["command.execute.before"]?.(
    {
      command: "enhance",
      sessionID: "session-1",
      arguments: "fix tests",
    },
    output as never,
  );

  expect(output.parts).toEqual([{ type: "text", text: "fallback prompt" }]);
  expect(calls.map((entry) => entry.method)).toEqual(["clearPrompt", "showToast"]);
});

test("EnhanceCommandPlugin falls back when clearPrompt API is missing", async () => {
  const { calls, pluginInput } = createPluginContext({ missingClearPrompt: true });
  const plugin = await EnhanceCommandPlugin(pluginInput);

  const output = {
    parts: [{ type: "text", text: "fallback prompt" }],
  };

  await plugin["command.execute.before"]?.(
    {
      command: "enhance",
      sessionID: "session-1",
      arguments: "fix tests",
    },
    output as never,
  );

  expect(output.parts).toEqual([{ type: "text", text: "fallback prompt" }]);
  expect(calls.map((entry) => entry.method)).toEqual(["showToast"]);
});

test("EnhanceCommandPlugin ignores non-/enhance commands", async () => {
  const { calls, pluginInput } = createPluginContext();
  const plugin = await EnhanceCommandPlugin(pluginInput);

  const output = {
    parts: [{ type: "text", text: "raw" }],
  };

  await plugin["command.execute.before"]?.(
    {
      command: "other",
      sessionID: "session-1",
      arguments: "ignored",
    },
    output as never,
  );

  expect(output.parts).toEqual([{ type: "text", text: "raw" }]);
  expect(calls).toEqual([]);
});
