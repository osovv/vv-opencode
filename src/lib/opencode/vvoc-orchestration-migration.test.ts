// FILE: src/lib/opencode/vvoc-orchestration-migration.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the explicit legacy orchestration migration removes only orchestration sections, backs up before writing, reports changes, and leaves invalid documents untouched.
//   SCOPE: Root-only, preset-only, mixed, absent, invalid-JSON, backup-content, formatting preservation, and idempotent second-run cases over isolated temp directories.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/opencode/vvoc-orchestration-migration.ts]
//   LINKS: [M-CLI-CONFIG, V-M-CLI-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   withConfigDir - Runs one test body against an isolated temp config directory.
//   [test scenarios] - Migration behavior is expressed through module-level tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-REMOVE-SESSION-ORCHESTRATION-PROFILES T-004 - Added coverage for the explicit legacy orchestration migration and its loud failure boundary.]
// END_CHANGE_SUMMARY

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateVvocOrchestration } from "./vvoc-orchestration-migration.js";

async function withConfigDir(
  fn: (paths: { configDir: string; configPath: string }) => Promise<void>,
): Promise<void> {
  const configDir = await mkdtemp(join(tmpdir(), "vvoc-orchestration-migration-"));
  try {
    const vvocDir = join(configDir, "vvoc");
    await mkdir(vvocDir, { recursive: true });
    await fn({ configDir, configPath: join(vvocDir, "vvoc.json") });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

test("removes a root orchestration section and preserves every other key", async () => {
  await withConfigDir(async ({ configPath }) => {
    const original =
      JSON.stringify(
        {
          version: 3,
          roles: { default: "prov/m" },
          orchestration: { profile: "balanced" },
          plugins: { workflow: true },
        },
        null,
        2,
      ) + "\n";
    await writeFile(configPath, original, "utf8");

    const outcome = await migrateVvocOrchestration([{ vvocConfigPath: configPath }]);

    expect(outcome.migrated).toHaveLength(1);
    expect(outcome.migrated[0]?.sections).toEqual(["orchestration"]);
    expect(outcome.skippedInvalid).toHaveLength(0);
    const migrated = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(migrated).not.toHaveProperty("orchestration");
    expect(migrated.roles).toEqual({ default: "prov/m" });
    expect(migrated.plugins).toEqual({ workflow: true });
    expect(await readFile(outcome.migrated[0]!.backupPath, "utf8")).toBe(original);
  });
});

test("removes per-preset orchestration sections and keeps preset roles", async () => {
  await withConfigDir(async ({ configPath }) => {
    const original =
      JSON.stringify(
        {
          version: 3,
          roles: {},
          presets: {
            custom: { agents: { default: "prov/m" }, orchestration: { profile: "delegated" } },
            untouched: { agents: { fast: "prov/f" } },
          },
          plugins: {},
        },
        null,
        2,
      ) + "\n";
    await writeFile(configPath, original, "utf8");

    const outcome = await migrateVvocOrchestration([{ vvocConfigPath: configPath }]);

    expect(outcome.migrated[0]?.sections).toEqual(["presets.custom.orchestration"]);
    const migrated = JSON.parse(await readFile(configPath, "utf8")) as {
      presets: Record<string, Record<string, unknown>>;
    };
    expect(migrated.presets.custom).toEqual({ agents: { default: "prov/m" } });
    expect(migrated.presets.untouched).toEqual({ agents: { fast: "prov/f" } });
  });
});

test("reports a document without orchestration as unchanged and writes no backup", async () => {
  await withConfigDir(async ({ configPath }) => {
    const original = JSON.stringify({ version: 3, roles: {}, plugins: {} }, null, 2) + "\n";
    await writeFile(configPath, original, "utf8");

    const outcome = await migrateVvocOrchestration([{ vvocConfigPath: configPath }]);

    expect(outcome.migrated).toHaveLength(0);
    expect(outcome.unchanged).toEqual([configPath]);
    expect(await readFile(configPath, "utf8")).toBe(original);
    const entries = await readdir(join(configPath, ".."));
    expect(entries.filter((name) => name.includes("vvoc-backup"))).toEqual([]);
  });
});

test("leaves invalid JSON untouched so strict validation fails loudly", async () => {
  await withConfigDir(async ({ configPath }) => {
    const original = '{ "version": 3, "orchestration": { "profile": "balanced" }, }\n';
    await writeFile(configPath, original, "utf8");

    const outcome = await migrateVvocOrchestration([{ vvocConfigPath: configPath }]);

    expect(outcome.skippedInvalid).toEqual([configPath]);
    expect(await readFile(configPath, "utf8")).toBe(original);
  });
});

test("a second pass is a no-op and deduplicates repeated paths", async () => {
  await withConfigDir(async ({ configPath }) => {
    const original =
      JSON.stringify({ version: 3, orchestration: { profile: "balanced" }, roles: {} }, null, 2) +
      "\n";
    await writeFile(configPath, original, "utf8");

    const first = await migrateVvocOrchestration([
      { vvocConfigPath: configPath },
      { vvocConfigPath: configPath },
    ]);
    expect(first.migrated).toHaveLength(1);
    const afterFirst = await readFile(configPath, "utf8");

    const second = await migrateVvocOrchestration([{ vvocConfigPath: configPath }]);
    expect(second.migrated).toHaveLength(0);
    expect(await readFile(configPath, "utf8")).toBe(afterFirst);
  });
});
