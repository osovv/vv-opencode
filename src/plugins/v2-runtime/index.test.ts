// FILE: src/plugins/v2-runtime/index.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the dual-runtime foundation: dual entrypoint shape, v1 delegation, hook merging order, and per-plugin error isolation.
//   SCOPE: Unit tests for defineDualPlugin, mergeV1Hooks, and aggregateV1Plugins with fake v1 factories and hook objects only.
//   DEPENDS: [src/plugins/v2-runtime/index.ts, @opencode/plugin, @opencode-ai/plugin]
//   LINKS: [V-M-PLUGIN-V2-RUNTIME, M-PLUGIN-V2-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   fakeInput - Builds a minimal v1 PluginInput for delegation tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION - Added the dual-runtime foundation test suite.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { aggregateV1Plugins, defineDualPlugin, mergeV1Hooks } from "./index.js";
import { isFullV2Context, setupV2Plugins, V2_PLUGIN_SETUPS } from "./setup.js";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";

function fakeInput(): PluginInput {
  return {
    client: {} as PluginInput["client"],
    project: {
      id: "p",
      directory: "/tmp/project",
      worktree: {},
    } as unknown as PluginInput["project"],
    directory: "/tmp/project",
    worktree: "/tmp/project",
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: {} as PluginInput["$"],
  };
}

describe("defineDualPlugin", () => {
  test("exposes id, setup, and server on the default-export shape", () => {
    const v1 = async () => ({}) as Hooks;
    let setupSeen = 0;
    const dual = defineDualPlugin({
      id: "vvoc.test",
      v1,
      v2: () => {
        setupSeen += 1;
      },
    });

    expect(dual.id).toBe("vvoc.test");
    expect(typeof dual.setup).toBe("function");
    expect(typeof dual.server).toBe("function");
    expect(dual.server).toBe(v1);

    const cleanup = dual.setup({} as never);
    expect(setupSeen).toBe(1);
    expect(cleanup).toBeUndefined();
  });

  test("server delegates to the v1 factory with input and options", async () => {
    const seen: Array<{ input: PluginInput; options: Record<string, unknown> | undefined }> = [];
    const v1 = async (input: PluginInput, options?: Record<string, unknown>) => {
      seen.push({ input, options });
      return { "chat.message": async () => {} } as unknown as Hooks;
    };
    const dual = defineDualPlugin({ id: "vvoc.test", v1, v2: () => {} });

    const input = fakeInput();
    const hooks = await dual.server(input, { flag: true });

    expect(seen.length).toBe(1);
    expect(seen[0]?.input).toBe(input);
    expect(seen[0]?.options).toEqual({ flag: true });
    expect(typeof (hooks as Record<string, unknown>)["chat.message"]).toBe("function");
  });
});

describe("mergeV1Hooks", () => {
  test("runs each hook key sequentially across children in registration order", async () => {
    const calls: string[] = [];
    const first: Hooks = {
      "tool.execute.before": async () => {
        calls.push("first-before");
      },
    };
    const second: Hooks = {
      "tool.execute.before": async () => {
        calls.push("second-before");
      },
      "chat.message": async () => {
        calls.push("second-message");
      },
    };

    const merged = mergeV1Hooks([first, second]);
    await (merged["tool.execute.before"] as (input: unknown, output: unknown) => Promise<void>)(
      {},
      {},
    );
    await (merged["chat.message"] as (input: unknown, output: unknown) => Promise<void>)({}, {});

    expect(calls).toEqual(["first-before", "second-before", "second-message"]);
  });

  test("merges dispose handlers and runs them in registration order", async () => {
    const calls: string[] = [];
    const first: Hooks = {
      dispose: async () => {
        calls.push("dispose-first");
      },
    };
    const second: Hooks = {
      dispose: async () => {
        calls.push("dispose-second");
      },
    };

    const merged = mergeV1Hooks([first, second]);
    await merged.dispose?.();

    expect(calls).toEqual(["dispose-first", "dispose-second"]);
  });

  test("skips undefined children and children without the requested key", async () => {
    const calls: string[] = [];
    const only: Hooks = {
      "chat.message": async () => {
        calls.push("only");
      },
    };

    const merged = mergeV1Hooks([undefined, {}, only]);
    await (merged["chat.message"] as (input: unknown, output: unknown) => Promise<void>)({}, {});

    expect(calls).toEqual(["only"]);
    expect(Object.keys(merged)).toEqual(["chat.message"]);
  });

  test("produces an object with no hook members for an empty list", () => {
    const merged = mergeV1Hooks([]);
    expect(Object.keys(merged)).toEqual([]);
  });
});

describe("aggregateV1Plugins", () => {
  test("aggregates factories sequentially and merges their hooks", async () => {
    const calls: string[] = [];
    const factories = [
      async () => {
        calls.push("factory-1");
        return { "chat.message": async () => {} } as unknown as Hooks;
      },
      async () => {
        calls.push("factory-2");
        return { "chat.params": async () => {} } as unknown as Hooks;
      },
    ];

    const merged = await aggregateV1Plugins(factories as never, fakeInput());

    expect(calls).toEqual(["factory-1", "factory-2"]);
    expect(Object.keys(merged).sort()).toEqual(["chat.message", "chat.params"]);
  });

  test("isolates a throwing factory and still loads the remaining plugins", async () => {
    const errors: Array<{ index: number; message: string }> = [];
    const factories = [
      async () => {
        throw new Error("boom");
      },
      async () => ({ "chat.message": async () => {} }) as unknown as Hooks,
    ];

    const merged = await aggregateV1Plugins(
      factories as never,
      fakeInput(),
      undefined,
      (error, index) => {
        errors.push({ index, message: String(error) });
      },
    );

    expect(errors.length).toBe(1);
    expect(errors[0]?.index).toBe(0);
    expect(errors[0]?.message).toContain("boom");
    expect(Object.keys(merged)).toEqual(["chat.message"]);
  });
});

describe("setupV2Plugins runtime detection", () => {
  test("treats the v1 v2-bridge context as not full v2 and registers nothing", async () => {
    const bridgeContext = {
      agent: {},
      aisdk: {},
      catalog: {},
      command: {},
      integration: {},
      options: {},
      plugin: {},
      reference: {},
      skill: {},
    };
    expect(isFullV2Context(bridgeContext as never)).toBe(false);
    const cleanup = await setupV2Plugins(bridgeContext as never);
    expect(cleanup).toBeUndefined();
  });

  test("accepts a context carrying the full v2 domain set", () => {
    const fullContext = {
      app: {},
      location: {},
      options: {},
      agent: {},
      event: {},
      session: {},
      storage: {},
      tool: {},
    };
    expect(isFullV2Context(fullContext as never)).toBe(true);
  });

  test("wires plugin setups through the adapter with resolver and watcher, isolating failures", async () => {
    const savedSetups = [...V2_PLUGIN_SETUPS];
    const seen: string[] = [];
    const cleanups: string[] = [];
    const registrations: Array<{ domain: string; name: string }> = [];
    const fakeSetup = (adapter: {
      resolver: unknown;
      watchConfig: unknown;
      ctx: { tool: { hook: unknown }; session: { hook: unknown }; event: { subscribe: unknown } };
    }) => {
      seen.push("wired");
      expect(typeof (adapter.resolver as { forDirectory: unknown }).forDirectory).toBe("function");
      expect(typeof adapter.watchConfig).toBe("function");
      if (typeof adapter.ctx.tool.hook === "function")
        registrations.push({ domain: "tool", name: "hook" });
      if (typeof adapter.ctx.session.hook === "function")
        registrations.push({ domain: "session", name: "hook" });
      if (typeof adapter.ctx.event.subscribe === "function")
        registrations.push({ domain: "event", name: "subscribe" });
      return () => {
        cleanups.push("dispose");
      };
    };
    V2_PLUGIN_SETUPS.push({ name: "probe.ok", setup: fakeSetup as never });
    V2_PLUGIN_SETUPS.push({
      name: "probe.failing",
      setup: () => {
        throw new Error("setup boom");
      },
    });

    try {
      const fullContext = {
        app: {},
        location: {},
        options: {},
        tool: { hook: async () => ({ dispose: async () => {} }) },
        session: { hook: async () => ({ dispose: async () => {} }) },
        event: { subscribe: async () => {} },
        storage: {},
      };
      const cleanup = await setupV2Plugins(fullContext as never);
      expect(seen).toEqual(["wired"]);
      expect(registrations.length).toBe(3);
      expect(typeof cleanup).toBe("function");
      await cleanup?.();
      expect(cleanups).toEqual(["dispose"]);
    } finally {
      V2_PLUGIN_SETUPS.length = 0;
      V2_PLUGIN_SETUPS.push(...savedSetups);
    }
  });
});
