// FILE: src/plugins/system-context-injection/v2.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the v2 system-context injection port: per-session gating, agent filtering, idempotent SystemPart appends, and fail-soft behavior.
//   SCOPE: Unit tests for setupSystemContextInjectionV2 with a mocked adapter capturing the context hook callback.
//   DEPENDS: [src/plugins/system-context-injection/v2.ts, src/plugins/v2-runtime/setup.ts]
//   LINKS: [V-M-PLUGIN-SYSTEM-CONTEXT-INJECTION, M-PLUGIN-SYSTEM-CONTEXT-INJECTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CapturedEvent - Synthetic context hook event shape driven through the captured callback.
//   makeHookHarness - Builds a mocked adapter that captures the registered context hook and drives it with synthetic events.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-004 - Added the v2 system-context injection test suite.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { setupSystemContextInjectionV2 } from "./v2.js";
import type { V2AdapterContext } from "../v2-runtime/setup.js";
import { createDefaultVvocConfig } from "../../lib/vvoc-config.js";

interface CapturedEvent {
  sessionID: string;
  agent: string;
  system: Array<{ type: string; text: string }>;
}

function makeHookHarness(options?: { enabled?: boolean; agentDirectory?: string }) {
  const enabled = options?.enabled ?? true;
  const directory = options?.agentDirectory ?? "/tmp/proj-a";
  const config = createDefaultVvocConfig();
  const plugins = config.plugins as Record<string, unknown>;
  plugins["system-context-injection"] = enabled;

  let hookCallback: ((event: CapturedEvent) => Promise<void> | void) | undefined;
  const adapter = {
    ctx: {
      session: {
        hook: async (_name: string, callback: (event: CapturedEvent) => Promise<void> | void) => {
          hookCallback = callback;
          return { dispose: async () => {} };
        },
        get: async () => ({ location: { directory } }),
      },
    },
    resolver: {
      forSession: async () => ({
        directory,
        config,
        source: { kind: "project", path: `${directory}/.vvoc/vvoc.json` },
        warnings: [],
        loadedAt: 0,
      }),
      forDirectory: async () => undefined,
      invalidate: () => {},
      cachedDirectories: [],
    },
    watchConfig: async () => () => {},
  } as unknown as V2AdapterContext;

  const fire = async (event: CapturedEvent): Promise<void> => {
    if (!hookCallback) throw new Error("hook not registered");
    await hookCallback(event);
    await new Promise((resolve) => setTimeout(resolve, 5));
  };

  return { adapter, fire };
}

describe("setupSystemContextInjectionV2", () => {
  test("appends universal contexts as text SystemParts for a primary agent", async () => {
    const { adapter, fire } = makeHookHarness();
    const cleanup = await setupSystemContextInjectionV2(adapter);
    expect(typeof cleanup).toBe("function");

    const event: CapturedEvent = { sessionID: "s-1", agent: "build", system: [] };
    await fire(event);

    expect(event.system.length).toBeGreaterThan(0);
    expect(event.system.every((part) => part.type === "text")).toBe(true);
    const joined = event.system.map((part) => part.text).join("\n");
    expect(joined).toContain("<semantic_continuity>");
    expect(joined).toContain("<correctness_obligations>");

    await cleanup?.();
  });

  test("adds the concrete policy block only for vv-controller", async () => {
    const { adapter, fire } = makeHookHarness();
    await setupSystemContextInjectionV2(adapter);

    const controllerEvent: CapturedEvent = { sessionID: "s-2", agent: "vv-controller", system: [] };
    await fire(controllerEvent);
    const buildEvent: CapturedEvent = { sessionID: "s-3", agent: "build", system: [] };
    await fire(buildEvent);

    const controllerText = controllerEvent.system.map((part) => part.text).join("\n");
    const buildText = buildEvent.system.map((part) => part.text).join("\n");
    expect(controllerText.length).toBeGreaterThan(buildText.length);
  });

  test("skips known subagents and internal agents entirely", async () => {
    const { adapter, fire } = makeHookHarness();
    await setupSystemContextInjectionV2(adapter);

    const subagentEvent: CapturedEvent = { sessionID: "s-4", agent: "general", system: [] };
    await fire(subagentEvent);
    const internalEvent: CapturedEvent = { sessionID: "s-5", agent: "title", system: [] };
    await fire(internalEvent);

    expect(subagentEvent.system).toEqual([]);
    expect(internalEvent.system).toEqual([]);
  });

  test("does not inject twice when the context is already present", async () => {
    const { adapter, fire } = makeHookHarness();
    await setupSystemContextInjectionV2(adapter);

    const event: CapturedEvent = { sessionID: "s-6", agent: "build", system: [] };
    await fire(event);
    const countAfterFirst = event.system.length;
    await fire(event);

    expect(event.system.length).toBe(countAfterFirst);
  });

  test("skips injection when the toggle is disabled for the session location", async () => {
    const { adapter, fire } = makeHookHarness({ enabled: false });
    await setupSystemContextInjectionV2(adapter);

    const event: CapturedEvent = { sessionID: "s-7", agent: "build", system: [] };
    await fire(event);

    expect(event.system).toEqual([]);
  });
});
