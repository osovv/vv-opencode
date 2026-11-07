// FILE: src/runtime/session-settings.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the session-owned settings record codec, config birth values, live-config projection, RMW metadata merging with foreign-key preservation, lineage resolution guards, and the one-shot legacy-binding migration.
//   SCOPE: Deterministic in-memory fixtures only; no real host, filesystem data dir, or network.
//   DEPENDS: [bun:test, src/runtime/session-settings.js, src/lib/vvoc-config.js]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   baseConfig - Default vvoc config fixture with deterministic roles and toggles.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SESSION-OWNED-SETTINGS T-001 - Covered the settings record, projection, RMW merge, lineage, and migration.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createDefaultVvocConfig, type VvocConfig } from "../lib/vvoc-config.js";
import type { NativeSessionView } from "./types.js";
import {
  decodeFamilySettings,
  FAMILY_SETTINGS_VERSION,
  INTERNAL_PRIMARY_AGENTS,
  isFamilyRootView,
  mergeSettingsIntoMetadata,
  migrateFamilyBindings,
  projectFamilyConfig,
  readSettingsFromMetadata,
  resolveSessionFamily,
  SESSION_SETTINGS_METADATA_KEY,
  SessionLineageError,
  settingsFromConfig,
  settingsId,
  type LegacyBindingsReader,
} from "./session-settings.js";

function baseConfig(): VvocConfig {
  const config = createDefaultVvocConfig();
  config.roles = { smart: "prov/m-smart", fast: "prov/m-fast" };
  config.orchestration = { profile: "orchestrated" };
  config.plugins = { ...config.plugins, workflow: false, "peak-hours": { enabled: true } };
  return config;
}

describe("decodeFamilySettings", () => {
  test("accepts a valid record and normalizes the preset", () => {
    const decoded = decodeFamilySettings({
      version: 1,
      preset: " vv-codex ",
      roles: { smart: "prov/m1" },
      profile: "balanced",
      plugins: { workflow: false },
    });
    expect(decoded.error).toBeUndefined();
    expect(decoded.settings).toEqual({
      version: 1,
      preset: "vv-codex",
      roles: { smart: "prov/m1" },
      profile: "balanced",
      plugins: { workflow: false },
    });
  });

  test("rejects wrong version, malformed maps, unknown profiles, and bad presets", () => {
    expect(decodeFamilySettings({}).error).toBeDefined();
    expect(decodeFamilySettings({ version: 2 }).error).toBeDefined();
    expect(
      decodeFamilySettings({
        version: FAMILY_SETTINGS_VERSION,
        roles: { r: "" },
        profile: "balanced",
        plugins: {},
      }).error,
    ).toBeDefined();
    expect(
      decodeFamilySettings({
        version: FAMILY_SETTINGS_VERSION,
        roles: {},
        profile: "no-such-profile",
        plugins: {},
      }).error,
    ).toBeDefined();
    expect(
      decodeFamilySettings({
        version: FAMILY_SETTINGS_VERSION,
        roles: {},
        profile: "balanced",
        plugins: { workflow: "yes" },
      }).error,
    ).toBeDefined();
    expect(
      decodeFamilySettings({
        version: FAMILY_SETTINGS_VERSION,
        roles: {},
        profile: "balanced",
        plugins: {},
        preset: "  ",
      }).error,
    ).toBeDefined();
  });
});

describe("settingsFromConfig and projection", () => {
  test("resolves toggles, roles, and profile from the effective config", () => {
    const settings = settingsFromConfig(baseConfig());
    expect(settings.version).toBe(1);
    expect(settings.profile).toBe("orchestrated");
    expect(settings.roles).toEqual({ smart: "prov/m-smart", fast: "prov/m-fast" });
    expect(settings.plugins.workflow).toBe(false);
    expect(settings.plugins["peak-hours"]).toBe(true);
    expect(settings.preset).toBeUndefined();
  });

  test("projection keeps live detail and credentials while settings govern toggles", () => {
    const settings = settingsFromConfig(baseConfig());
    const live = baseConfig();
    live.roles = { smart: "prov/m-new" };
    live.orchestration = { profile: "single-session" };
    live.plugins = {
      ...live.plugins,
      workflow: true,
      "peak-hours": { enabled: false, schedules: { p: { windows: [] } } },
    };
    const projected = projectFamilyConfig(settings, live);
    // Family-governed fields come from the settings record.
    expect(projected.roles).toEqual({ smart: "prov/m-smart", fast: "prov/m-fast" });
    expect(projected.orchestration).toEqual({ profile: "orchestrated" });
    expect(projected.plugins.workflow).toBe(false);
    // Resolved-enabled overrides a later live disable while live detail survives.
    expect(projected.plugins["peak-hours"]).toEqual({
      enabled: true,
      schedules: { p: { windows: [] } },
    });
    // Credential-bearing sections pass through from live untouched.
    expect(projected.web).toEqual(live.web);
  });

  test("projection does not mutate the live config", () => {
    const settings = settingsFromConfig(baseConfig());
    const live = baseConfig();
    const before = structuredClone(live);
    projectFamilyConfig(settings, live);
    expect(live).toEqual(before);
  });

  test("settingsId is stable and differs across values", () => {
    const a = settingsFromConfig(baseConfig());
    expect(settingsId(a)).toBe(settingsId(a));
    const flipped = { ...a, profile: "balanced" as const };
    expect(settingsId(a)).not.toBe(settingsId(flipped));
  });
});

describe("read-modify-write merge", () => {
  test("merge sets only the settings key and preserves foreign keys", () => {
    const foreign = { user: { note: "keep me" }, count: 3 };
    const settings = settingsFromConfig(baseConfig());
    const merged = mergeSettingsIntoMetadata(foreign, settings);
    expect(merged.user).toEqual({ note: "keep me" });
    expect(merged.count).toBe(3);
    expect(merged[SESSION_SETTINGS_METADATA_KEY]).toEqual(settings);
  });

  test("merge tolerates absent metadata and readSettingsFromMetadata round-trips", () => {
    const settings = settingsFromConfig(baseConfig());
    const merged = mergeSettingsIntoMetadata(undefined, settings);
    const read = readSettingsFromMetadata(merged);
    expect(read && "settings" in read ? read.settings : undefined).toEqual(settings);
    expect(readSettingsFromMetadata(undefined)).toBeUndefined();
    const missing = readSettingsFromMetadata({ other: 1 });
    expect(missing).toBeUndefined();
    const broken = readSettingsFromMetadata({ [SESSION_SETTINGS_METADATA_KEY]: { version: 9 } });
    expect(broken && "error" in broken ? broken.error : undefined).toBeDefined();
  });
});

describe("lineage resolution", () => {
  const sessions = new Map<string, NativeSessionView>([
    ["ses_root", { id: "ses_root", locationDirectory: "/w" }],
    ["ses_child", { id: "ses_child", parentID: "ses_root" }],
    ["ses_grand", { id: "ses_grand", forkSessionID: "ses_child" }],
    [
      "ses_aux",
      { id: "ses_aux", parentID: "ses_root", metadata: { vvocAuxiliary: { kind: "title" } } },
    ],
  ]);
  const readSession = async (sessionID: string) => sessions.get(sessionID);

  test("walks parentID and fork links to the root", async () => {
    await expect(resolveSessionFamily({ sessionID: "ses_grand", readSession })).resolves.toBe(
      "ses_root",
    );
    await expect(resolveSessionFamily({ sessionID: "ses_child", readSession })).resolves.toBe(
      "ses_root",
    );
    await expect(resolveSessionFamily({ sessionID: "ses_root", readSession })).resolves.toBe(
      "ses_root",
    );
  });

  test("refuses cycles and missing sessions", async () => {
    const cyclic = new Map<string, NativeSessionView>([
      ["a", { id: "a", parentID: "b" }],
      ["b", { id: "b", parentID: "a" }],
    ]);
    await expect(
      resolveSessionFamily({ sessionID: "a", readSession: async (id) => cyclic.get(id) }),
    ).rejects.toBeInstanceOf(SessionLineageError);
    await expect(
      resolveSessionFamily({ sessionID: "ses_ghost", readSession }),
    ).rejects.toBeInstanceOf(SessionLineageError);
  });

  test("birthable roots exclude parented sessions and internal agents", () => {
    expect(isFamilyRootView(sessions.get("ses_root")!)).toBe(true);
    expect(isFamilyRootView(sessions.get("ses_child")!)).toBe(false);
    expect(isFamilyRootView({ id: "t", agent: "title" })).toBe(false);
    expect(isFamilyRootView({ id: "s", agent: "summary" })).toBe(false);
    expect(isFamilyRootView({ id: "c", agent: "compaction" })).toBe(false);
    expect(INTERNAL_PRIMARY_AGENTS.has("title")).toBe(true);
  });
});

describe("legacy binding migration", () => {
  function fixtureReader(
    families: readonly { familyId: string; snapshotHash: string }[],
    snapshots: Readonly<Record<string, unknown>>,
  ): LegacyBindingsReader & { prune(): Promise<void>; readonly pruneCalls: number } {
    let pruneCalls = 0;
    return {
      async listFamilies() {
        return families;
      },
      async readSnapshot(hash) {
        return snapshots[hash];
      },
      get pruneCalls() {
        return pruneCalls;
      },
      async prune() {
        pruneCalls += 1;
      },
    };
  }

  const policy = {
    roles: { smart: "prov/m1" },
    orchestration: { profile: "orchestrated" },
    plugins: { workflow: false },
  };

  test("converts live roots, skips dead roots and corrupt snapshots, prunes on success", async () => {
    const reader = fixtureReader(
      [
        { familyId: "ses_live", snapshotHash: "h1" },
        { familyId: "ses_dead", snapshotHash: "h2" },
        { familyId: "ses_corrupt", snapshotHash: "h3" },
      ],
      { h1: { policy }, h3: "not-an-object" },
    );
    const writes: Array<{ sessionID: string; settings: unknown }> = [];
    const outcome = await migrateFamilyBindings({
      reader,
      readSession: async (id) => (id === "ses_live" ? { id } : undefined),
      writeSettings: async (sessionID, settings) => {
        writes.push({ sessionID, settings });
      },
    });
    expect(outcome.converted).toEqual(["ses_live"]);
    expect([...outcome.skipped].sort()).toEqual(["ses_corrupt", "ses_dead"]);
    expect(outcome.failed).toEqual([]);
    expect(outcome.pruned).toBe(true);
    expect(reader.pruneCalls).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].sessionID).toBe("ses_live");
    // The migrated record carries the fully resolved toggle map, roles, and profile.
    expect(writes[0].settings).toMatchObject({
      version: 1,
      roles: { smart: "prov/m1" },
      profile: "orchestrated",
      plugins: { workflow: false, analytics: true },
    });
  });

  test("a write failure keeps directories and reports the family as failed", async () => {
    const reader = fixtureReader([{ familyId: "ses_live", snapshotHash: "h1" }], {
      h1: { policy },
    });
    const outcome = await migrateFamilyBindings({
      reader,
      readSession: async (id) => (id === "ses_live" ? { id } : undefined),
      writeSettings: async () => {
        throw new Error("host write failed");
      },
    });
    expect(outcome.converted).toEqual([]);
    expect(outcome.failed).toEqual(["ses_live"]);
    expect(outcome.pruned).toBe(false);
    expect(reader.pruneCalls).toBe(0);
  });

  test("a non-root legacy family id is skipped", async () => {
    const reader = fixtureReader([{ familyId: "ses_child", snapshotHash: "h1" }], {
      h1: { policy },
    });
    const outcome = await migrateFamilyBindings({
      reader,
      readSession: async (id) => (id === "ses_child" ? { id, parentID: "ses_root" } : undefined),
      writeSettings: async () => undefined,
    });
    expect(outcome.skipped).toEqual(["ses_child"]);
    expect(outcome.pruned).toBe(true);
  });
});
