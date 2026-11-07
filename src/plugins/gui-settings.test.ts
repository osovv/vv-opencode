// FILE: src/plugins/gui-settings.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Test the GUI settings RPC handlers and their production wiring: bounded defaults projection, conservative CLI-reused profile write, honest stub/unsupported session verdicts, value-free failure mapping, and a registrar-level roundtrip that decodes replies with the client decoders.
//   SCOPE: In-memory deps for the four handlers plus a disk-backed production-wiring roundtrip over a temporary sandbox vvoc.json; no live host and no network.
//   DEPENDS: [node:fs/promises, node:os, node:path, src/plugins/gui-settings.ts, src/rpc.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-PLUGIN-GUI-SETTINGS, M-GUI-SPIKE, V-M-PLUGIN-GUI-SETTINGS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   memoryDeps - Builds the in-memory handler deps and records profile writes.
//   mkdtempRoot - Creates the sandbox directory for the production-wiring roundtrip.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [GUI-SPike initial skeleton - Added handler verdict tests plus the sandbox roundtrip over the production CLI-reused wiring.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGuiSettingsHandlers,
  GuiSettingsPlugin,
  STUB_SETTINGS_NOTE,
  registerGuiSettingsRpc,
  type GuiSettingsDeps,
} from "./gui-settings.js";
import {
  VVOC_GUI_RPC_ID,
  decodeDefaultsGetOutput,
  decodeSessionGetOutput,
  type DefaultsGetOutput,
} from "../rpc.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";

function memoryDeps(
  overrides: Partial<GuiSettingsDeps> = {},
): GuiSettingsDeps & { writes: Array<{ profile: string; scope: string }> } {
  const writes: Array<{ profile: string; scope: string }> = [];
  return {
    writes,
    readDefaults: async () => ({
      profile: "balanced",
      plugins: { guardian: true, analytics: true, peakHours: false },
      source: { kind: "project", path: "/sandbox/.vvoc/vvoc.json" },
    }),
    writeProfile: async (profile, scope) => {
      writes.push({ profile, scope });
      return { action: "updated", path: "/sandbox/.vvoc/vvoc.json" };
    },
    sessionExists: async (sessionID) => sessionID === "ses-known",
    ...overrides,
  };
}

describe("gui settings handlers", () => {
  test("projects the effective defaults as an available reply", async () => {
    const deps = memoryDeps();
    const handlers = createGuiSettingsHandlers(deps);
    const reply = await handlers["defaults.get"]({});
    const decoded: DefaultsGetOutput = decodeDefaultsGetOutput(reply);
    expect(decoded.status).toBe("available");
    expect(decoded.profile).toBe("balanced");
    expect(decoded.plugins).toEqual({ guardian: true, analytics: true, peakHours: false });
    expect(decoded.source?.kind).toBe("project");
    expect(decoded.source?.path).toBe("/sandbox/.vvoc/vvoc.json");
  });

  test("maps a defaults read failure to the value-free unavailable verdict", async () => {
    const deps = memoryDeps({
      readDefaults: async () => {
        throw new Error("effective config unavailable");
      },
    });
    const handlers = createGuiSettingsHandlers(deps);
    const decoded = decodeDefaultsGetOutput(await handlers["defaults.get"]({}));
    expect(decoded.status).toBe("unavailable");
    expect(decoded.error).toBe("config_unavailable");
    expect(JSON.stringify(decoded)).not.toContain("effective config unavailable");
  });

  test("routes defaults.set through the injected conservative write", async () => {
    const deps = memoryDeps();
    const handlers = createGuiSettingsHandlers(deps);
    const reply = await handlers["defaults.set"]({ profile: "delegated", scope: "project" });
    expect(deps.writes).toEqual([{ profile: "delegated", scope: "project" }]);
    expect(reply.action).toBe("updated");
    expect(reply.profile).toBe("delegated");
    expect(reply.path).toBe("/sandbox/.vvoc/vvoc.json");
  });

  test("maps a failed write to the unavailable verdict without raw errors", async () => {
    const deps = memoryDeps({
      writeProfile: async () => {
        throw new Error("EACCES: permission denied, open '/sandbox/.vvoc/vvoc.json'");
      },
    });
    const handlers = createGuiSettingsHandlers(deps);
    const reply = await handlers["defaults.set"]({ profile: "orchestrated", scope: "global" });
    expect(reply.action).toBe("unavailable");
    expect(reply.error).toBe("config_unavailable");
    expect(JSON.stringify(reply)).not.toContain("EACCES");
  });

  test("session.get answers the stub projection for an existing session", async () => {
    const handlers = createGuiSettingsHandlers(memoryDeps());
    const decoded = decodeSessionGetOutput(
      await handlers["session.get"]({ sessionID: "ses-known" }),
    );
    expect(decoded.status).toBe("stub");
    expect(decoded.profile).toBe("balanced");
    expect(decoded.note).toBe(STUB_SETTINGS_NOTE);
    expect(decoded.error).toBeUndefined();
  });

  test("session.get reports the lookup failure for an unknown session", async () => {
    const handlers = createGuiSettingsHandlers(memoryDeps());
    const decoded = decodeSessionGetOutput(
      await handlers["session.get"]({ sessionID: "ses-missing" }),
    );
    expect(decoded.status).toBe("unavailable");
    expect(decoded.error).toBe("session_lookup_failed");
  });

  test("session.get degrades to the config verdict when the defaults read fails", async () => {
    const deps = memoryDeps({
      readDefaults: async () => {
        throw new Error("broken");
      },
    });
    const handlers = createGuiSettingsHandlers(deps);
    const decoded = decodeSessionGetOutput(
      await handlers["session.get"]({ sessionID: "ses-known" }),
    );
    expect(decoded.status).toBe("unavailable");
    expect(decoded.error).toBe("config_unavailable");
  });

  test("session.patch stays explicitly unsupported for an existing session", async () => {
    const handlers = createGuiSettingsHandlers(memoryDeps());
    const reply = await handlers["session.patch"]({ sessionID: "ses-known" });
    expect(reply.status).toBe("unsupported");
    expect(reply.error).toBe("session_settings_unsupported");
  });

  test("session.patch reports the lookup failure for an unknown session", async () => {
    const handlers = createGuiSettingsHandlers(memoryDeps());
    const reply = await handlers["session.patch"]({ sessionID: "ses-missing" });
    expect(reply.status).toBe("unavailable");
    expect(reply.error).toBe("session_lookup_failed");
  });
});

describe("gui settings registration", () => {
  test("registers the versioned contract on the server registrar", async () => {
    const registered: Array<{ id: string }> = [];
    const registration = await registerGuiSettingsRpc({
      location: { directory: "/sandbox" },
      rpc: {
        register: async (definition) => {
          registered.push({ id: definition.id });
          return { dispose: async () => undefined };
        },
      },
      session: { get: async () => undefined },
    });
    expect(registered).toEqual([{ id: VVOC_GUI_RPC_ID }]);
    await registration.dispose();
  });

  test("exposes the native aggregate plugin shape", () => {
    expect(GuiSettingsPlugin.id).toBe("vvoc-gui-settings");
    expect(typeof GuiSettingsPlugin.setup).toBe("function");
  });

  test("roundtrips the production wiring against a sandbox vvoc.json", async () => {
    const sandbox = await mkdtempRoot();
    try {
      const configDir = join(sandbox, ".vvoc");
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "vvoc.json"), renderVvocConfig(createDefaultVvocConfig()));

      let registered:
        | {
            id: string;
            handlers: Record<string, (input: unknown) => Promise<unknown>>;
          }
        | undefined;
      const handle = await registerGuiSettingsRpc({
        location: { directory: sandbox },
        rpc: {
          register: async (definition, handlers) => {
            registered = {
              id: definition.id,
              handlers: handlers as Record<string, (input: unknown) => Promise<unknown>>,
            };
            return { dispose: async () => undefined };
          },
        },
        session: { get: async (input) => ({ id: input.sessionID }) },
      });

      expect(registered?.id).toBe(VVOC_GUI_RPC_ID);
      const reply = (await registered?.handlers["defaults.get"]({})) as DefaultsGetOutput;
      const decoded = decodeDefaultsGetOutput(reply);
      expect(decoded.status).toBe("available");
      expect(decoded.profile).toBe("balanced");
      expect(decoded.source?.kind).toBe("project");

      const setReply = (await registered?.handlers["defaults.set"]({
        profile: "orchestrated",
        scope: "project",
      })) as { action: string; path: string };
      expect(setReply.action).toBe("updated");
      const written = await readFile(join(configDir, "vvoc.json"), "utf8");
      expect(JSON.parse(written).orchestration.profile).toBe("orchestrated");

      const reread = decodeDefaultsGetOutput(
        (await registered?.handlers["defaults.get"]({})) as unknown,
      );
      expect(reread.profile).toBe("orchestrated");

      await handle.dispose();
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

async function mkdtempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "vvoc-gui-settings-test-"));
}
