// FILE: src/tui/rebind/plugin.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify /vv-rebind native command registration, active-session gating, marker content, no-session handling, and bounded failures.
//   SCOPE: Native keymap layer wiring with injected dependencies; the marker write is verified through the injected writer boundary.
//   DEPENDS: [bun:test, @opencode/plugin/tui, src/tui/rebind/plugin.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CommandShape - Minimal captured command shape.
//   MarkerInput - Marker writer input captured by the harness.
//   createHarness - Build the TUI harness with a scripted route and marker writer.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-VV-REBIND-TUI-COMMAND T-001 - Added /vv-rebind coverage for registration, gating, marker content, and bounded output.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin/tui";
import { REBIND_COMMAND_ID, registerRebindTuiCommand } from "./plugin.js";

type CommandShape = {
  id?: string;
  group?: string;
  slash?: { name: string };
  enabled: () => boolean;
  run: (input?: string) => Promise<void> | void;
};

type MarkerInput = { directory: string; sessionId: string };

function createHarness(initialRoute: { type: "session"; sessionID: string } | { type: "home" }) {
  const toasts: Array<{ variant?: string; title?: string; message: string }> = [];
  const markers: MarkerInput[] = [];
  let route = initialRoute;
  let layer: { commands?: CommandShape[] } | undefined;
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
        layer = input();
      },
    },
  } as unknown as Plugin.Context;
  const mount = () => {
    claim?.render?.();
  };
  return {
    context,
    toasts,
    markers,
    layer: () => layer,
    claim: () => claim,
    mount,
    setRoute: (next: typeof route) => {
      route = next;
    },
  };
}

describe("rebind TUI command", () => {
  test("registers the vv-rebind slash command on the app slot", () => {
    const harness = createHarness({ type: "session", sessionID: "session-1" });
    registerRebindTuiCommand(harness.context, {
      writeMarker: async () => {
        throw new Error("must not run");
      },
      directory: () => "/project",
    });
    harness.mount();

    expect(harness.claim()?.append).toBe("app");
    const commands = harness.layer()?.commands ?? [];
    expect(commands).toHaveLength(1);
    expect(commands[0]?.id).toBe(REBIND_COMMAND_ID);
    expect(commands[0]?.group).toBe("VVOC");
    expect(commands[0]?.slash?.name).toBe("vv-rebind");
    expect(commands[0]?.enabled()).toBe(true);
  });

  test("writes exactly one marker naming the active session and working directory", async () => {
    const harness = createHarness({ type: "session", sessionID: "session-1" });
    registerRebindTuiCommand(harness.context, {
      writeMarker: async (input) => {
        harness.markers.push(input);
        return { id: "req-1", requestedAt: 1, directory: input.directory };
      },
      directory: () => "/project",
    });
    harness.mount();

    await harness.layer()?.commands?.[0]?.run();

    expect(harness.markers).toEqual([{ directory: "/project", sessionId: "session-1" }]);
    expect(harness.toasts).toEqual([
      {
        variant: "success",
        title: "Rebind session",
        message: "Re-resolving the configuration from the next message.",
      },
    ]);
  });

  test("is disabled and shows a bounded hint without an open session", async () => {
    const harness = createHarness({ type: "home" });
    registerRebindTuiCommand(harness.context, {
      writeMarker: async (input) => {
        harness.markers.push(input);
        return { id: "req-1", requestedAt: 1, directory: input.directory };
      },
      directory: () => "/project",
    });
    harness.mount();

    expect(harness.layer()?.commands?.[0]?.enabled()).toBe(false);
    // The palette can still invoke a disabled command; the run path must not write.
    await harness.layer()?.commands?.[0]?.run();

    expect(harness.markers).toEqual([]);
    expect(harness.toasts).toHaveLength(1);
    expect(harness.toasts[0]?.variant).toBe("warning");
    expect(harness.toasts[0]?.message).toBe("Open a session before running /vv-rebind.");
  });

  test("a failed marker write renders one bounded error and no success toast", async () => {
    const harness = createHarness({ type: "session", sessionID: "session-1" });
    registerRebindTuiCommand(harness.context, {
      writeMarker: async () => {
        throw new Error("marker directory is not writable");
      },
      directory: () => "/project",
    });
    harness.mount();

    await harness.layer()?.commands?.[0]?.run();

    expect(harness.markers).toEqual([]);
    expect(harness.toasts).toHaveLength(1);
    expect(harness.toasts[0]?.variant).toBe("error");
    expect(harness.toasts[0]?.message).toBe("marker directory is not writable");
  });

  test("an outcome after the user switched tabs renders nothing", async () => {
    const harness = createHarness({ type: "session", sessionID: "session-1" });
    const finishWrite: Array<() => void> = [];
    registerRebindTuiCommand(harness.context, {
      writeMarker: (input) =>
        new Promise((resolve) => {
          harness.markers.push(input);
          finishWrite.push(() =>
            resolve({ id: "req-1", requestedAt: 1, directory: input.directory }),
          );
        }),
      directory: () => "/project",
    });
    harness.mount();

    const pending = harness.layer()?.commands?.[0]?.run();
    harness.setRoute({ type: "session", sessionID: "session-2" });
    finishWrite[0]?.();
    await pending;

    expect(harness.markers).toHaveLength(1);
    expect(harness.toasts).toEqual([]);
  });
});
