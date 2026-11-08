// FILE: src/tui/settings/plugin.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for the /vv-settings native TUI command: registration shape, gating on an open session, the read path, the write path, and bounded failure toasts.
//   SCOPE: Keymap command registration and outcomes through injectable apply/describe seams; no host client is contacted.
//   DEPENDS: [bun:test, @opencode/plugin/tui, src/tui/settings/plugin.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CommandShape - Keymap command shape captured from a registered layer.
//   createHarness - Fake plugin context recording toasts, route, and the registered command.
//   dependencies - Injectable apply/describe seams recording their calls.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SESSION-OWNED-SETTINGS T-005 - Covered /vv-settings registration, session gating, show/apply outcomes, and error containment.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin/tui";
import {
  SETTINGS_COMMAND_ID,
  registerSettingsTuiCommand,
  type SettingsTuiDependencies,
} from "./plugin.js";

type CommandShape = {
  id?: string;
  slash?: { name: string; arguments?: boolean };
  enabled: () => boolean;
  run: (input?: string) => Promise<void> | void;
};

function createHarness(initialRoute: { type: "session"; sessionID: string } | { type: "home" }) {
  const toasts: Array<{ variant?: string; title?: string; message: string }> = [];
  let route = initialRoute;
  let command: CommandShape | undefined;
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
        const layer = input();
        command = layer.commands?.[0];
      },
    },
  } as unknown as Plugin.Context & { client: unknown };
  const mount = () => {
    claim?.render?.();
  };
  return {
    context,
    toasts,
    command: () => command,
    mount,
    setRoute: (next: typeof route) => {
      route = next;
    },
  };
}

function dependencies(overrides: Partial<SettingsTuiDependencies> = {}): {
  readonly deps: SettingsTuiDependencies;
  readonly applied: string[];
  readonly described: string[];
} {
  const applied: string[] = [];
  const described: string[] = [];
  return {
    deps: {
      apply: async ({ sessionID, actionText }) => {
        applied.push(`${sessionID}:${actionText}`);
        return {
          rootID: sessionID,
          settings: {
            version: 1,
            roles: { smart: "prov/m2" },
            profile: "orchestrated",
            plugins: {},
          },
        };
      },
      describe: async (sessionID) => {
        described.push(sessionID);
        return "profile: orchestrated";
      },
      ...overrides,
    },
    applied,
    described,
  };
}

describe("registerSettingsTuiCommand", () => {
  test("registers the slash command on the app slot with arguments enabled", () => {
    const harness = createHarness({ type: "session", sessionID: "ses_1" });
    const { deps } = dependencies();
    const dispose = registerSettingsTuiCommand(harness.context, deps);
    harness.mount();
    const command = harness.command();
    expect(command?.id).toBe(SETTINGS_COMMAND_ID);
    expect(command?.slash?.name).toBe("vv-settings");
    expect(command?.slash?.arguments).toBe(true);
    expect(command?.enabled()).toBe(true);
    expect(typeof dispose).toBe("function");
  });

  test("is disabled without an open session and warns when dispatched", async () => {
    const harness = createHarness({ type: "home" });
    const { deps, applied } = dependencies();
    registerSettingsTuiCommand(harness.context, deps);
    harness.mount();
    expect(harness.command()?.enabled()).toBe(false);
    await harness.command()?.run("profile orchestrated");
    expect(applied).toHaveLength(0);
    expect(harness.toasts[0]?.variant).toBe("warning");
  });

  test("with no argument it shows the current settings summary", async () => {
    const harness = createHarness({ type: "session", sessionID: "ses_1" });
    const { deps, described, applied } = dependencies();
    registerSettingsTuiCommand(harness.context, deps);
    harness.mount();
    await harness.command()?.run("");
    expect(described).toEqual(["ses_1"]);
    expect(applied).toHaveLength(0);
    expect(harness.toasts[0]?.variant).toBe("info");
    expect(harness.toasts[0]?.message).toContain("profile: orchestrated");
  });

  test("with no recorded settings it says so", async () => {
    const harness = createHarness({ type: "session", sessionID: "ses_1" });
    const { deps } = dependencies({
      describe: async () => undefined,
    });
    registerSettingsTuiCommand(harness.context, deps);
    harness.mount();
    await harness.command()?.run(undefined);
    expect(harness.toasts[0]?.message).toContain("No settings recorded yet");
  });

  test("an argument applies the action to the active session's family", async () => {
    const harness = createHarness({ type: "session", sessionID: "ses_9" });
    const { deps, applied, described } = dependencies();
    registerSettingsTuiCommand(harness.context, deps);
    harness.mount();
    await harness.command()?.run("preset vv-zai");
    expect(applied).toEqual(["ses_9:preset vv-zai"]);
    expect(described).toHaveLength(0);
    expect(harness.toasts[0]?.variant).toBe("success");
    expect(harness.toasts[0]?.message).toContain("profile: orchestrated");
  });

  test("a failed apply surfaces a bounded error toast and never throws", async () => {
    const harness = createHarness({ type: "session", sessionID: "ses_1" });
    const { deps } = dependencies({
      apply: async () => {
        throw new Error(
          "Family settings for ses_1 are invalid: roles are not a nonempty-string map",
        );
      },
    });
    registerSettingsTuiCommand(harness.context, deps);
    harness.mount();
    await expect(harness.command()?.run("profile orchestrated")).resolves.toBeUndefined();
    expect(harness.toasts[0]?.variant).toBe("error");
    expect(harness.toasts[0]?.message).toContain("roles are not a nonempty-string map");
  });

  test("a failed read surfaces an error toast and never throws", async () => {
    const harness = createHarness({ type: "session", sessionID: "ses_1" });
    const { deps } = dependencies({
      describe: async () => {
        throw new Error("no running OpenCode service was discovered");
      },
    });
    registerSettingsTuiCommand(harness.context, deps);
    harness.mount();
    await expect(harness.command()?.run("")).resolves.toBeUndefined();
    expect(harness.toasts[0]?.variant).toBe("error");
    expect(harness.toasts[0]?.message).toContain("no running OpenCode service");
  });
});
