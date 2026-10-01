// FILE: src/tui/context/plugin.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify /context native command registration, policy gating, active-session gating, execution, and bounded failures.
//   SCOPE: Native keymap layer wiring with injected dependencies; rendering is verified through invocation boundaries.
//   DEPENDS: [bun:test, @opencode/plugin/tui, src/tui/context/plugin.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CommandShape - Minimal captured command shape.
//   createHarness - Build the TUI plugin harness with a scripted initial route.
//   createDependencies - Build plugin dependencies for the harness.
//   emptyAnalysis - Build an empty ContextAnalysis for a session.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 - Rewrote /context coverage for the native keymap layer and policy gate.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { Plugin } from "@opencode/plugin/tui";
import { vvocContextTuiPlugin } from "../../tui.js";
import { registerContextTuiPlugin, type ContextTuiDependencies } from "./plugin.js";
import type { ContextAnalysis } from "./types.js";

type CommandShape = {
  id?: string;
  group?: string;
  slash?: { name: string };
  enabled: () => boolean;
  run: (input?: string) => Promise<void> | void;
};

function createHarness(initialRoute: { type: "session"; sessionID: string } | { type: "home" }) {
  const toasts: Array<{ variant?: string; title?: string; message: string }> = [];
  let route = initialRoute;
  let layer: { commands?: CommandShape[] } | undefined;
  let layers = 0;
  let claim: { append?: string; render?: () => unknown } | undefined;
  const context = {
    ui: {
      router: { current: () => route },
      toast: {
        show: (toast: { variant?: string; title?: string; message: string }) => toasts.push(toast),
      },
      slot: (value: { append?: string; render?: () => unknown }) => {
        claim = value;
        return () => undefined;
      },
    },
    keymap: {
      layer: (input: () => { commands?: CommandShape[] }) => {
        layers += 1;
        layer = input();
      },
    },
  } as unknown as Plugin.Context;
  // Slot claims run their render inside the host component tree; mounting the
  // claim is what registers the keymap layer on the real host.
  const mount = () => {
    claim?.render?.();
  };
  return {
    context,
    toasts,
    layer: () => layer,
    layers: () => layers,
    claim: () => claim,
    mount,
    setRoute: (next: typeof route) => {
      route = next;
    },
  };
}

function createDependencies(
  overrides: Partial<ContextTuiDependencies> = {},
): ContextTuiDependencies {
  return {
    isEnabled: () => true,
    revalidate: async () => true,
    collect: async (_ctx, sessionID) => emptyAnalysis(sessionID),
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
    totalMessageCount: 0,
    mcpServers: [],
    toolCatalogStatus: "unrequested",
    warnings: [],
  };
}

describe("context TUI plugin", () => {
  test("registers the context slash command and opens analysis for the active session", async () => {
    const harness = createHarness({ type: "session", sessionID: "session-1" });
    const opened: ContextAnalysis[] = [];
    registerContextTuiPlugin(
      harness.context,
      undefined,
      createDependencies({
        open: (_ctx, analysis) => opened.push(analysis),
      }),
    );
    harness.mount();

    const command = harness.layer()?.commands?.[0];
    expect(command?.slash?.name).toBe("context");
    expect(command?.group).toBe("VVOC");
    expect(command?.enabled()).toBe(true);
    await command?.run();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.sessionID).toBe("session-1");
  });

  test("keeps the command registered but disabled when the policy gate is off", () => {
    const harness = createHarness({ type: "session", sessionID: "session-1" });
    registerContextTuiPlugin(
      harness.context,
      undefined,
      createDependencies({ isEnabled: () => false }),
    );
    harness.mount();
    expect(harness.layers()).toBe(1);
    expect(harness.layer()?.commands?.[0]?.enabled()).toBe(false);
  });

  test("options.enabled === false skips registration entirely", () => {
    const harness = createHarness({ type: "session", sessionID: "session-1" });
    registerContextTuiPlugin(harness.context, { enabled: false }, createDependencies());
    expect(harness.claim()).toBeUndefined();
    expect(harness.layers()).toBe(0);
  });

  test("warns outside a session and reports bounded collection failures", async () => {
    const home = createHarness({ type: "home" });
    registerContextTuiPlugin(home.context, undefined, createDependencies());
    home.mount();
    await home.layer()?.commands?.[0]?.run();
    expect(home.toasts[0]?.variant).toBe("warning");

    const session = createHarness({ type: "session", sessionID: "session-1" });
    registerContextTuiPlugin(
      session.context,
      undefined,
      createDependencies({ collect: async () => Promise.reject(new Error("catalog failed")) }),
    );
    session.mount();
    await session.layer()?.commands?.[0]?.run();
    expect(session.toasts[0]).toMatchObject({
      variant: "error",
      title: "Context usage unavailable",
      message: "catalog failed",
    });
  });

  test("honors an explicit disabled captured policy on invocation", async () => {
    const harness = createHarness({ type: "session", sessionID: "session-1" });
    registerContextTuiPlugin(
      harness.context,
      undefined,
      createDependencies({ revalidate: async () => false }),
    );
    harness.mount();
    await harness.layer()?.commands?.[0]?.run();
    expect(harness.toasts[0]?.variant).toBe("warning");
    expect(harness.toasts[0]?.message).toContain("disabled");
  });

  test("composed entry registers every surface and disposes them all", async () => {
    const slots: Array<{ append?: string; replace?: string; render?: () => unknown }> = [];
    const disposers: Array<() => void> = [];
    let layers = 0;
    const location = { directory: "/p" };
    const context = {
      options: {},
      location,
      app: { version: "2.0.18", channel: "test" },
      theme: {
        text: {
          base: "#fff",
          muted: "#888",
          feedback: {
            warning: { base: "#ff0" },
            error: { base: "#f00" },
            success: { base: "#0f0" },
          },
        },
        hue: { accent: { 200: "#0ff" } },
      },
      data: {
        on: () => () => undefined,
        session: { get: () => ({ location }), message: { list: () => [] } },
        location: {
          default: () => location,
          agent: { list: () => [] },
          skill: { list: () => [] },
          mcp: { server: { list: () => [] } },
          model: { list: () => [] },
          provider: { list: () => [] },
        },
      },
      client: {
        rpc: () => ({ inspect: async () => undefined }),
        session: { context: async () => [] },
      },
      ui: {
        router: { current: () => ({ type: "home" }) },
        toast: { show: () => undefined },
        model: { current: () => undefined },
        dialog: { show: () => undefined, set: () => undefined },
        slot: (claim: unknown) => {
          slots.push(claim as { append?: string; replace?: string; render?: () => unknown });
          return () => undefined;
        },
      },
      keymap: {
        layer: () => {
          layers += 1;
        },
      },
    } as unknown as Plugin.Context;

    const cleanup = createRoot((dispose) => {
      const own = vvocContextTuiPlugin.setup(context);
      return () => {
        if (typeof own === "function") own();
        dispose();
      };
    });
    // The /context app slot, the indicator prompt.footer.status slot, the
    // branding sidebar.footer replacement, and the banner composer slot.
    expect(slots.length).toBeGreaterThanOrEqual(4);
    expect(slots.some((slot) => slot.replace === "sidebar.footer")).toBe(true);
    expect(slots.some((slot) => slot.append === "session.composer.top")).toBe(true);
    // Mounting the app slot registers the keymap command layer.
    slots.find((slot) => slot.append === "app")?.render?.();
    expect(layers).toBe(1);
    await expect(Promise.resolve(cleanup())).resolves.toBeUndefined();
    void disposers;
  });

  test("refreshes policy on native step boundaries for an initially unbound session and disposes all slots", async () => {
    const handlers = new Map<string, Array<(event: unknown) => void>>();
    const slots: Array<{ append?: string; replace?: string; render?: () => unknown }> = [];
    let slotDisposers = 0;
    const location = { directory: "/p" };
    let captureExists = false;
    let inspectCalls = 0;
    let layer: { commands?: Array<{ enabled: () => boolean }> } | undefined;
    const policyResult = () =>
      captureExists
        ? {
            version: 1,
            status: "complete",
            location: { directory: "/p", projectID: "p" },
            observedAt: 1,
            policy: {
              status: "available",
              scope: "family",
              contextEnabled: false,
              analyticsEnabled: false,
              peakHours: { enabled: false, mode: "soft", graceActiveSessions: true, schedules: {} },
              provenance: {
                familyId: "f",
                snapshotId: "s",
                capturedAt: 1,
                location: { directory: "/p" },
              },
            },
            warnings: [],
          }
        : undefined;
    const context = {
      options: {},
      location,
      app: { version: "2.0.18", channel: "test" },
      theme: {
        text: {
          base: "#fff",
          muted: "#888",
          feedback: {
            warning: { base: "#ff0" },
            error: { base: "#f00" },
            success: { base: "#0f0" },
          },
        },
        hue: { accent: { 200: "#0ff" } },
      },
      data: {
        on: (type: string, handler: (event: unknown) => void) => {
          handlers.set(type, [...(handlers.get(type) ?? []), handler]);
          return () => undefined;
        },
        session: { get: () => ({ location }), message: { list: () => [] } },
        location: {
          default: () => location,
          agent: { list: () => [] },
          skill: { list: () => [] },
          mcp: { server: { list: () => [] } },
          model: { list: () => [] },
          provider: { list: () => [] },
        },
      },
      client: {
        rpc: () => ({
          inspect: async () => {
            inspectCalls += 1;
            return policyResult();
          },
        }),
        session: { context: async () => [] },
      },
      ui: {
        router: { current: () => ({ type: "session", sessionID: "s1" }) },
        toast: { show: () => undefined },
        model: { current: () => undefined },
        dialog: { show: () => undefined, set: () => undefined },
        slot: (claim: unknown) => {
          slots.push(claim as { append?: string; replace?: string; render?: () => unknown });
          return () => {
            slotDisposers += 1;
          };
        },
      },
      keymap: {
        layer: (input: () => { commands?: Array<{ enabled: () => boolean }> }) => {
          layer = input();
        },
      },
    } as unknown as Plugin.Context;

    const cleanup = createRoot((dispose) => {
      const own = vvocContextTuiPlugin.setup(context);
      return () => {
        if (typeof own === "function") own();
        dispose();
      };
    });
    slots.find((slot) => slot.append === "app")?.render?.();
    const command = layer?.commands?.[0];
    const emit = (type: string, event: unknown): void => {
      for (const handler of handlers.get(type) ?? []) handler(event);
    };
    const flush = async (): Promise<void> => {
      for (let index = 0; index < 5; index += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 10));
    };

    await flush();
    expect(command?.enabled()).toBe(true);
    const before = inspectCalls;
    emit("session.inbox.enqueued", { data: { sessionID: "s1" } });
    await flush();
    expect(inspectCalls).toBeGreaterThan(before);
    // Capture is not committed yet: the policy stays unavailable and the
    // command remains reachable on the same session.
    expect(command?.enabled()).toBe(true);

    // The capture is now committed; a native step boundary must pick it up.
    captureExists = true;
    emit("session.step.ended", { data: { sessionID: "s1" } });
    await flush();
    expect(command?.enabled()).toBe(false);

    // A step boundary for another session must not trigger a refresh.
    const afterStep = inspectCalls;
    emit("session.step.started", { data: { sessionID: "other" } });
    await flush();
    expect(inspectCalls).toBe(afterStep);

    cleanup();
    expect(slotDisposers).toBeGreaterThanOrEqual(4);
  });

  test("does not open a dialog when the tab changed during collection", async () => {
    const harness = createHarness({ type: "session", sessionID: "session-1" });
    const opened: ContextAnalysis[] = [];
    registerContextTuiPlugin(harness.context, undefined, {
      isEnabled: () => true,
      revalidate: async () => true,
      collect: async (_ctx, sessionID) => {
        harness.setRoute({ type: "session", sessionID: "session-2" });
        return emptyAnalysis(sessionID);
      },
      open: (_ctx, analysis) => opened.push(analysis),
    });
    harness.mount();
    await harness.layer()?.commands?.[0]?.run();
    expect(opened).toHaveLength(0);
  });
});
