// FILE: src/commands/session.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-SESSION - explicit session-settings changes through lineage-rooted metadata read-modify-write.
//   SCOPE: Shared action parsing, family isolation (only the named family changes), foreign-metadata preservation on every write, preset/profile/role/plugin/pull-defaults application, and summary rendering.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/commands/session.ts, src/lib/vvoc-config.ts, src/runtime/session-settings.ts]
//   LINKS: [M-CLI-SESSION, V-M-CLI-SESSION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   [test scenarios] - Session-settings behavior coverage is expressed through module-level tests.
//   FakeSession - One fake host session row with optional parent, fork, and metadata.
//   FakeHost - In-memory host double implementing the client seam with replace-semantics metadata updates.
//   writeProjectConfig - Write the fixture project's vvoc.json through the canonical renderer.
//   makeProject - Create an isolated fixture project directory.
//   tempDirs - Temporary directories removed after each test.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SESSION-OWNED-SETTINGS T-004 - Covered the shared action parser, family isolation, the RMW foreign-key property, and every explicit settings action.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySessionSettingsAction,
  describeFamilySettings,
  parseSessionSettingsAction,
  readFamilySettingsViaClient,
} from "./session.js";
import type { SessionSettingsClient } from "../runtime/session-settings.js";
import { readSettingsFromMetadata } from "../runtime/session-settings.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";

// START_BLOCK_FAKE_HOST
const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

interface FakeSession {
  readonly id: string;
  parentID?: string;
  forkSessionID?: string;
  metadata?: Record<string, unknown>;
}

class FakeHost {
  readonly sessions = new Map<string, FakeSession>();
  readonly updates: Array<{ sessionID: string; metadata: Record<string, unknown> }> = [];

  add(session: FakeSession): void {
    this.sessions.set(session.id, { ...session });
  }

  client(): SessionSettingsClient {
    return {
      session: {
        get: async ({ sessionID }) => {
          const session = this.sessions.get(sessionID);
          if (session === undefined) throw new Error(`unknown session ${sessionID}`);
          return {
            id: session.id,
            ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
            ...(session.forkSessionID === undefined
              ? {}
              : { forkSessionID: session.forkSessionID }),
            ...(session.metadata === undefined ? {} : { metadata: session.metadata }),
          };
        },
        update: async ({
          sessionID,
          metadata,
        }: {
          sessionID: string;
          metadata?: Record<string, unknown>;
        }) => {
          const session = this.sessions.get(sessionID);
          if (session === undefined) throw new Error(`unknown session ${sessionID}`);
          // Native semantics: the whole metadata map is replaced.
          this.sessions.set(sessionID, { ...session, metadata });
          this.updates.push({ sessionID, metadata: { ...metadata } });
          return { id: sessionID };
        },
      },
    };
  }
}
// END_BLOCK_FAKE_HOST

async function writeProjectConfig(
  dir: string,
  mutate: (config: ReturnType<typeof createDefaultVvocConfig>) => void,
): Promise<string> {
  await mkdir(join(dir, ".vvoc"), { recursive: true });
  const config = createDefaultVvocConfig();
  mutate(config);
  await writeFile(join(dir, ".vvoc", "vvoc.json"), renderVvocConfig(config), "utf8");
  return dir;
}

function makeProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vvoc-session-set-"));
}

describe("parseSessionSettingsAction", () => {
  test("parses every shared text action", () => {
    expect(parseSessionSettingsAction("preset vv-zai")).toEqual({
      kind: "preset",
      name: "vv-zai",
    });
    expect(parseSessionSettingsAction("profile orchestrated")).toEqual({
      kind: "profile",
      profile: "orchestrated",
    });
    expect(parseSessionSettingsAction("role smart prov/m2#high")).toEqual({
      kind: "role-set",
      roleId: "smart",
      model: "prov/m2#high",
    });
    expect(parseSessionSettingsAction("role unset smart")).toEqual({
      kind: "role-unset",
      roleId: "smart",
    });
    expect(parseSessionSettingsAction("plugin secrets-redaction off")).toEqual({
      kind: "plugin",
      plugin: "secrets-redaction",
      enabled: false,
    });
    expect(parseSessionSettingsAction("pull-defaults")).toEqual({ kind: "pull-defaults" });
  });

  test("rejects empty and unknown actions with the accepted syntax", () => {
    expect(() => parseSessionSettingsAction("")).toThrow("settings action required");
    expect(() => parseSessionSettingsAction("freeze")).toThrow(/unknown settings action/);
    expect(() => parseSessionSettingsAction("plugin secrets-redaction")).toThrow(/usage: plugin/);
  });
});

describe("applySessionSettingsAction", () => {
  test("changes only the named family and preserves foreign metadata keys", async () => {
    const host = new FakeHost();
    host.add({ id: "root_a", metadata: { user: { note: "keep me" } } });
    host.add({ id: "child_a", parentID: "root_a" });
    host.add({ id: "root_b", metadata: { other: 1 } });

    const project = await makeProject();
    try {
      const result = await applySessionSettingsAction({
        client: host.client(),
        sessionID: "child_a",
        action: { kind: "profile", profile: "orchestrated" },
        cwd: project,
      });
      expect(result.rootID).toBe("root_a");
      // Family A was written through a child id, exactly once, at the root.
      expect(host.updates).toHaveLength(1);
      expect(host.updates[0]?.sessionID).toBe("root_a");
      // The foreign metadata key survived the replace-semantics write.
      expect(host.sessions.get("root_a")?.metadata?.user).toEqual({ note: "keep me" });
      expect(readSettingsFromMetadata(host.sessions.get("root_a")?.metadata)).toMatchObject({
        settings: { profile: "orchestrated" },
      });
      // Family B was not touched.
      expect(host.sessions.get("root_b")?.metadata).toEqual({ other: 1 });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("preset resolves the configured preset's roles and profile", async () => {
    const host = new FakeHost();
    host.add({ id: "ses_root" });
    const project = await makeProject();
    try {
      await writeProjectConfig(project, (config) => {
        config.presets["vv-test"] = {
          description: "test preset",
          agents: { smart: "prov/m-smart#high", fast: "prov/m-fast" },
          orchestration: { profile: "orchestrated" },
        };
      });
      const result = await applySessionSettingsAction({
        client: host.client(),
        sessionID: "ses_root",
        action: { kind: "preset", name: "vv-test" },
        cwd: project,
      });
      expect(result.settings.preset).toBe("vv-test");
      expect(result.settings.profile).toBe("orchestrated");
      expect(result.settings.roles).toEqual({
        smart: "prov/m-smart#high",
        fast: "prov/m-fast",
      });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("unknown preset names fail without writing metadata", async () => {
    const host = new FakeHost();
    host.add({ id: "ses_root" });
    const project = await makeProject();
    try {
      await expect(
        applySessionSettingsAction({
          client: host.client(),
          sessionID: "ses_root",
          action: { kind: "preset", name: "missing" },
          cwd: project,
        }),
      ).rejects.toThrow(/unknown preset: missing/);
      expect(host.updates).toHaveLength(0);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("role set and role unset update exactly one role entry", async () => {
    const host = new FakeHost();
    host.add({ id: "ses_root" });
    const project = await makeProject();
    try {
      const set = await applySessionSettingsAction({
        client: host.client(),
        sessionID: "ses_root",
        action: { kind: "role-set", roleId: "smart", model: "prov/m2#high" },
        cwd: project,
      });
      expect(set.settings.roles.smart).toBe("prov/m2#high");
      const unset = await applySessionSettingsAction({
        client: host.client(),
        sessionID: "ses_root",
        action: { kind: "role-unset", roleId: "smart" },
        cwd: project,
      });
      expect(unset.settings.roles.smart).toBeUndefined();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("invalid role ids and unknown plugin names are rejected before any write", async () => {
    const host = new FakeHost();
    host.add({ id: "ses_root" });
    const project = await makeProject();
    try {
      await expect(
        applySessionSettingsAction({
          client: host.client(),
          sessionID: "ses_root",
          action: { kind: "role-set", roleId: "Bad Role", model: "prov/m" },
          cwd: project,
        }),
      ).rejects.toThrow(/invalid role id/);
      await expect(
        applySessionSettingsAction({
          client: host.client(),
          sessionID: "ses_root",
          action: { kind: "plugin", plugin: "not-a-plugin", enabled: true },
          cwd: project,
        }),
      ).rejects.toThrow(/unknown plugin/);
      expect(host.updates).toHaveLength(0);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("pull-defaults replaces the record with the current effective defaults", async () => {
    const host = new FakeHost();
    host.add({
      id: "ses_root",
      metadata: { keep: "me" },
    });
    const project = await makeProject();
    try {
      const result = await applySessionSettingsAction({
        client: host.client(),
        sessionID: "ses_root",
        action: { kind: "pull-defaults" },
        cwd: project,
      });
      expect(result.settings.preset).toBeUndefined();
      expect(result.settings.profile).toBeDefined();
      // The RMW write still preserves the foreign key.
      expect(host.sessions.get("ses_root")?.metadata?.keep).toBe("me");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  test("readFamilySettingsViaClient resolves through lineage or undefined when unborn", async () => {
    const host = new FakeHost();
    host.add({ id: "ses_root" });
    host.add({ id: "ses_child", parentID: "ses_root" });
    const client = host.client();
    expect(await readFamilySettingsViaClient({ client, sessionID: "ses_child" })).toBeUndefined();
    const project = await makeProject();
    tempDirs.push(project);
    await applySessionSettingsAction({
      client,
      sessionID: "ses_child",
      action: { kind: "profile", profile: "single-session" },
      cwd: project,
    });
    const read = await readFamilySettingsViaClient({ client, sessionID: "ses_child" });
    expect(read?.profile).toBe("single-session");
  });
});

describe("describeFamilySettings", () => {
  test("renders bounded deterministic summary lines", () => {
    const lines = describeFamilySettings({
      version: 1,
      preset: "vv-zai",
      roles: { smart: "prov/m2", default: "prov/m1" },
      profile: "orchestrated",
      plugins: { "secrets-redaction": true, "hashline-edit": false },
    });
    expect(lines).toEqual([
      "preset: vv-zai",
      "roles: default=prov/m1, smart=prov/m2",
      "profile: orchestrated",
      "plugins: hashline-edit=off, secrets-redaction=on",
    ]);
  });
});
