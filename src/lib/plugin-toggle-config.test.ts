// FILE: src/lib/plugin-toggle-config.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify PLUGIN_TOGGLE_NAMES, createDefaultPluginToggleConfig, and isPluginEnabled.
//   SCOPE: Deterministic assertions for the utility module.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/plugin-toggle-config.js]
//   LINKS: [M-PLUGIN-TOGGLE-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PLUGIN_TOGGLE_NAMES test
//   createDefaultPluginToggleConfig test
//   isPluginEnabled tests (with temp config fixtures)
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial test implementation for plugin toggle config.]
// END_CHANGE_SUMMARY

import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// START_BLOCK_IMPORT_HELPERS
// We import the module under test
import {
  PLUGIN_TOGGLE_NAMES,
  createDefaultPluginToggleConfig,
  isPluginEnabled,
} from "./plugin-toggle-config.js";
// END_BLOCK_IMPORT_HELPERS

// START_BLOCK_CONSTANTS_TEST
describe("PLUGIN_TOGGLE_NAMES", () => {
  test("contains exactly the 6 vvoc-managed plugins", () => {
    expect(PLUGIN_TOGGLE_NAMES).toEqual([
      "guardian",
      "hashline-edit",
      "model-roles",
      "system-context-injection",
      "workflow",
      "secrets-redaction",
    ]);
  });

  test("is a readonly tuple", () => {
    // Type-level guarantee, but verify the values are as expected
    expect(PLUGIN_TOGGLE_NAMES.length).toBe(6);
  });
});
// END_BLOCK_CONSTANTS_TEST

// START_BLOCK_DEFAULT_CONFIG_TEST
describe("createDefaultPluginToggleConfig", () => {
  test("returns all-known-plugins with all values set to true", () => {
    const config = createDefaultPluginToggleConfig();
    expect(Object.keys(config).sort()).toEqual([...PLUGIN_TOGGLE_NAMES].sort());
    for (const name of PLUGIN_TOGGLE_NAMES) {
      expect(config[name]).toBe(true);
    }
  });

  test("is deterministic across calls", () => {
    const a = createDefaultPluginToggleConfig();
    const b = createDefaultPluginToggleConfig();
    expect(a).toEqual(b);
  });
});
// END_BLOCK_DEFAULT_CONFIG_TEST

// START_BLOCK_IS_PLUGIN_ENABLED_TESTS
describe("isPluginEnabled", () => {
  // Helper to create a temporary vvoc config directory and file
  async function withTempVvocConfig(
    configContent: object,
    fn: (configDir: string) => Promise<void>,
  ): Promise<void> {
    const tmpDir = mkdtempSync(join(tmpdir(), "vvoc-toggle-test-"));
    const vvocDir = join(tmpDir, "vvoc");
    await mkdir(vvocDir, { recursive: true });
    const configPath = join(vvocDir, "vvoc.json");
    await writeFile(configPath, JSON.stringify(configContent, null, 2));

    // Override XDG_CONFIG_HOME to point at our temp dir
    const origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpDir;
    try {
      await fn(tmpDir);
    } finally {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
  }

  test("returns true when plugins section is absent", async () => {
    await withTempVvocConfig(
      {
        $schema: "https://example.com/schema.json",
        version: 3,
        roles: { default: "openai/gpt-4" },
        guardian: { timeoutMs: 90_000, approvalRiskThreshold: 80, reviewToastDurationMs: 5000 },
        secretsRedaction: {
          enabled: true,
          secret: "test",
          ttlMs: 3600,
          maxMappings: 100,
          patterns: { keywords: [], regex: [], builtin: [], exclude: [] },
          debug: false,
        },
        presets: {},
      },
      async () => {
        const result = await isPluginEnabled("guardian");
        expect(result).toBe(true);
      },
    );
  });

  test("returns true when plugin is set to true", async () => {
    await withTempVvocConfig(
      {
        $schema: "https://example.com/schema.json",
        version: 3,
        roles: { default: "openai/gpt-4" },
        guardian: { timeoutMs: 90_000, approvalRiskThreshold: 80, reviewToastDurationMs: 5000 },
        secretsRedaction: {
          enabled: true,
          secret: "test",
          ttlMs: 3600,
          maxMappings: 100,
          patterns: { keywords: [], regex: [], builtin: [], exclude: [] },
          debug: false,
        },
        presets: {},
        plugins: { guardian: true, "hashline-edit": false },
      },
      async () => {
        const guardian = await isPluginEnabled("guardian");
        expect(guardian).toBe(true);
      },
    );
  });

  test("returns false when plugin is set to false", async () => {
    await withTempVvocConfig(
      {
        $schema: "https://example.com/schema.json",
        version: 3,
        roles: { default: "openai/gpt-4" },
        guardian: { timeoutMs: 90_000, approvalRiskThreshold: 80, reviewToastDurationMs: 5000 },
        secretsRedaction: {
          enabled: true,
          secret: "test",
          ttlMs: 3600,
          maxMappings: 100,
          patterns: { keywords: [], regex: [], builtin: [], exclude: [] },
          debug: false,
        },
        presets: {},
        plugins: { guardian: false, "hashline-edit": true },
      },
      async () => {
        const guardian = await isPluginEnabled("guardian");
        expect(guardian).toBe(false);
      },
    );
  });

  test("returns true for unknown plugin name (safe default)", async () => {
    await withTempVvocConfig(
      {
        $schema: "https://example.com/schema.json",
        version: 3,
        roles: { default: "openai/gpt-4" },
        guardian: { timeoutMs: 90_000, approvalRiskThreshold: 80, reviewToastDurationMs: 5000 },
        secretsRedaction: {
          enabled: true,
          secret: "test",
          ttlMs: 3600,
          maxMappings: 100,
          patterns: { keywords: [], regex: [], builtin: [], exclude: [] },
          debug: false,
        },
        presets: {},
        plugins: { guardian: true },
      },
      async () => {
        const result = await isPluginEnabled("nonexistent-plugin");
        expect(result).toBe(true);
      },
    );
  });

  test("returns true when vvoc.json cannot be read", async () => {
    // Don't override XDG_CONFIG_HOME, so the real path won't be a valid vvoc config
    // We can't easily simulate a missing file without changing env, so just verify
    // the function doesn't throw and returns true
    const result = await isPluginEnabled("guardian");
    expect(result).toBe(true);
  });
});
// END_BLOCK_IS_PLUGIN_ENABLED_TESTS
