// FILE: src/tui/context/plugin.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify /context command registration, toggle behavior, active-session gating, execution, and bounded failures.
//   SCOPE: Modern TUI command wiring with injected dependencies; rendering implementation is tested through invocation boundaries.
//   DEPENDS: [bun:test, @opencode-ai/plugin/tui, src/tui/context/plugin.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   context TUI plugin tests - Exercise command metadata and fail-soft control flow.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added /context TUI registration and failure regression coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { registerContextTuiPlugin, type ContextTuiDependencies } from "./plugin.js";
import type { ContextAnalysis } from "./types.js";

describe("context TUI plugin", () => {
  test("registers the context slash command and opens analysis for the active session", async () => {
    const harness = createHarness({ name: "session", params: { sessionID: "session-1" } });
    const opened: ContextAnalysis[] = [];
    const dependencies = createDependencies({
      open: (_api, analysis) => opened.push(analysis),
    });

    await registerContextTuiPlugin(harness.api, undefined, dependencies);

    expect(harness.layer.commands[0]?.slashName).toBe("context");
    expect(harness.layer.commands[0]?.category).toBe("VVOC");
    expect(harness.layer.commands[0]?.enabled()).toBe(true);
    await harness.layer.commands[0]?.run();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.sessionID).toBe("session-1");
    expect(harness.disposers).toHaveLength(1);
  });

  test("does not register when the vvoc context toggle is disabled", async () => {
    const harness = createHarness({ name: "home" });
    const dependencies = createDependencies({ enabled: async () => false });

    await registerContextTuiPlugin(harness.api, undefined, dependencies);

    expect(harness.registerCount()).toBe(0);
  });

  test("warns outside a session and reports bounded collection failures", async () => {
    const home = createHarness({ name: "home" });
    await registerContextTuiPlugin(home.api, undefined, createDependencies());
    await home.layer.commands[0]?.run();
    expect(home.toasts[0]?.variant).toBe("warning");

    const session = createHarness({ name: "session", params: { sessionID: "session-1" } });
    await registerContextTuiPlugin(
      session.api,
      undefined,
      createDependencies({ collect: async () => Promise.reject(new Error("catalog failed")) }),
    );
    await session.layer.commands[0]?.run();
    expect(session.toasts[0]).toMatchObject({
      variant: "error",
      title: "Context usage unavailable",
      message: "catalog failed",
    });
  });
});

type CommandShape = {
  slashName?: string;
  category?: string;
  enabled: () => boolean;
  run: () => Promise<void> | void;
};

function createHarness(route: { name: string; params?: Record<string, unknown> }) {
  const toasts: Array<{ variant?: string; title?: string; message: string }> = [];
  const disposers: Array<() => void> = [];
  let registrations = 0;
  const layer: { commands: CommandShape[] } = { commands: [] };
  const api = {
    route: { current: route },
    keymap: {
      registerLayer: (value: { commands: CommandShape[] }) => {
        registrations += 1;
        layer.commands = value.commands;
        return () => undefined;
      },
    },
    lifecycle: {
      onDispose: (dispose: () => void) => {
        disposers.push(dispose);
        return () => undefined;
      },
    },
    ui: {
      toast: (toast: { variant?: string; title?: string; message: string }) => toasts.push(toast),
    },
    state: { path: { directory: "/tmp/project" } },
  } as unknown as TuiPluginApi;

  return { api, layer, toasts, disposers, registerCount: () => registrations };
}

function createDependencies(
  overrides: Partial<ContextTuiDependencies> = {},
): ContextTuiDependencies {
  return {
    enabled: async () => true,
    collect: async (_api, sessionID) => emptyAnalysis(sessionID),
    open: () => undefined,
    ...overrides,
  };
}

function emptyAnalysis(sessionID: string): ContextAnalysis {
  return {
    sessionID,
    categories: [],
    estimatedKnownTokens: 0,
    estimatedTotalTokens: 0,
    estimationDriftTokens: 0,
    compacted: false,
    activeMessageCount: 0,
    mcpServers: [],
    warnings: [],
  };
}
