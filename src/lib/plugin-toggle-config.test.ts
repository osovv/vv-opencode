// FILE: src/lib/plugin-toggle-config.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify PLUGIN_TOGGLE_NAMES, createDefaultPluginToggleConfig, and pure isPluginEnabled behavior.
//   SCOPE: Deterministic assertions for the utility module.
//   DEPENDS: [bun:test, src/lib/plugin-toggle-config.js]
//   LINKS: [M-PLUGIN-TOGGLE-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PLUGIN_TOGGLE_NAMES test
//   createDefaultPluginToggleConfig test
//   isPluginEnabled tests
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added canonical default-enabled context toggle coverage.]
//   LAST_CHANGE: [v1.1.0 - Switched plugin toggle tests to pure config-object assertions.]
//   LAST_CHANGE: [v1.0.0 - Initial test implementation for plugin toggle config.]
// END_CHANGE_SUMMARY

import { describe, test, expect } from "bun:test";

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
  test("contains exactly the 7 vvoc-managed plugins", () => {
    expect(PLUGIN_TOGGLE_NAMES).toEqual([
      "guardian",
      "hashline-edit",
      "model-roles",
      "system-context-injection",
      "workflow",
      "secrets-redaction",
      "context",
    ]);
  });

  test("is a readonly tuple", () => {
    // Type-level guarantee, but verify the values are as expected
    expect(PLUGIN_TOGGLE_NAMES.length).toBe(7);
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
  test("returns true when plugins section is absent", () => {
    const result = isPluginEnabled({}, "guardian");
    expect(result).toBe(true);
  });

  test("returns true when plugin is set to true", () => {
    const guardian = isPluginEnabled(
      { plugins: { guardian: true, "hashline-edit": false } },
      "guardian",
    );
    expect(guardian).toBe(true);
  });

  test("returns false when plugin is set to false", () => {
    const guardian = isPluginEnabled(
      { plugins: { guardian: false, "hashline-edit": true } },
      "guardian",
    );
    expect(guardian).toBe(false);
  });

  test("returns true for unknown plugin name (safe default)", () => {
    const result = isPluginEnabled({ plugins: { guardian: true } }, "nonexistent-plugin");
    expect(result).toBe(true);
  });
});
// END_BLOCK_IS_PLUGIN_ENABLED_TESTS
