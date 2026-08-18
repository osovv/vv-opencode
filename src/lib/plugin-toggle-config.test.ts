// FILE: src/lib/plugin-toggle-config.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify PLUGIN_TOGGLE_NAMES, createDefaultPluginToggleConfig, and pure isPluginEnabled behavior.
//   SCOPE: Deterministic assertions for the utility module.
//   DEPENDS: [bun:test, src/lib/plugin-toggle-config.js]
//   LINKS: [M-PLUGIN-TOGGLE-CONFIG, V-M-PLUGIN-TOGGLE-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WEB_TOOLS_PLUGIN_NAME - Canonical web-tools toggle key used by focused assertions.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.5.0 - Added tool-history-compaction toggle coverage and updated the canonical plugin count to nine.]
// END_CHANGE_SUMMARY

import { describe, test, expect } from "bun:test";

// START_BLOCK_IMPORT_HELPERS
// We import the module under test
import {
  PLUGIN_TOGGLE_NAMES,
  createDefaultPluginToggleConfig,
  isPluginEnabled,
  materializeHashlineEditEntry,
  materializeToolHistoryCompactionEntry,
  DEFAULT_HASHLINE_EDIT_ROUTING,
  DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY,
} from "./plugin-toggle-config.js";
// END_BLOCK_IMPORT_HELPERS

const WEB_TOOLS_PLUGIN_NAME = "web-tools";

// START_BLOCK_CONSTANTS_TEST
describe("PLUGIN_TOGGLE_NAMES", () => {
  test("contains exactly the 9 vvoc-managed plugins", () => {
    expect(PLUGIN_TOGGLE_NAMES).toEqual([
      "guardian",
      "hashline-edit",
      "model-roles",
      "system-context-injection",
      "workflow",
      "secrets-redaction",
      "context",
      WEB_TOOLS_PLUGIN_NAME,
      "tool-history-compaction",
    ]);
  });
  test("is a readonly tuple", () => {
    // Type-level guarantee, but verify the values are as expected
    expect(PLUGIN_TOGGLE_NAMES.length).toBe(9);
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

// START_BLOCK_WEB_TOOLS_TOGGLE_TESTS
describe("web-tools toggle", () => {
  test("createDefaultPluginToggleConfig sets web-tools to true", () => {
    expect(createDefaultPluginToggleConfig()[WEB_TOOLS_PLUGIN_NAME]).toBe(true);
  });

  test("isPluginEnabled returns true for web-tools when the plugins section is absent", () => {
    expect(isPluginEnabled({}, WEB_TOOLS_PLUGIN_NAME)).toBe(true);
  });

  test("isPluginEnabled returns false when web-tools is explicitly false", () => {
    expect(
      isPluginEnabled({ plugins: { [WEB_TOOLS_PLUGIN_NAME]: false } }, WEB_TOOLS_PLUGIN_NAME),
    ).toBe(false);
  });
});
// END_BLOCK_WEB_TOOLS_TOGGLE_TESTS

// START_BLOCK_OBJECT_ENTRY_TESTS
describe("object-form plugin entries", () => {
  test("object entry without enabled defaults to enabled", () => {
    expect(
      isPluginEnabled(
        { plugins: { "hashline-edit": { routing: { default: "hashline" } } } },
        "hashline-edit",
      ),
    ).toBe(true);
    expect(isPluginEnabled({ plugins: { "hashline-edit": {} } }, "hashline-edit")).toBe(true);
  });

  test("object entry respects the enabled flag", () => {
    expect(
      isPluginEnabled({ plugins: { "hashline-edit": { enabled: false } } }, "hashline-edit"),
    ).toBe(false);
    expect(
      isPluginEnabled(
        { plugins: { "hashline-edit": { enabled: true, routing: { default: "replace" } } } },
        "hashline-edit",
      ),
    ).toBe(true);
  });

  test("boolean entries keep their behavior next to object entries", () => {
    const config = {
      plugins: {
        guardian: false,
        "hashline-edit": { enabled: true, routing: { default: "hashline" } },
      },
    };
    expect(isPluginEnabled(config, "guardian")).toBe(false);
    expect(isPluginEnabled(config, "hashline-edit")).toBe(true);
  });
});
// END_BLOCK_OBJECT_ENTRY_TESTS

// START_BLOCK_MATERIALIZE_TESTS
describe("materializeHashlineEditEntry", () => {
  test("expands undefined and boolean entries to the full object with default routing", () => {
    expect(materializeHashlineEditEntry(undefined)).toEqual({
      enabled: true,
      routing: DEFAULT_HASHLINE_EDIT_ROUTING,
    });
    expect(materializeHashlineEditEntry(true)).toEqual({
      enabled: true,
      routing: DEFAULT_HASHLINE_EDIT_ROUTING,
    });
    expect(materializeHashlineEditEntry(false)).toEqual({
      enabled: false,
      routing: DEFAULT_HASHLINE_EDIT_ROUTING,
    });
  });

  test("preserves a user routing block that differs from the default", () => {
    const customRouting = { default: "hashline", rules: { qwen: "hashline" } };
    expect(materializeHashlineEditEntry({ enabled: true, routing: customRouting })).toEqual({
      enabled: true,
      routing: customRouting,
    });
  });

  test("keeps enabled=false and fills routing when absent on an object entry", () => {
    expect(materializeHashlineEditEntry({ enabled: false })).toEqual({
      enabled: false,
      routing: DEFAULT_HASHLINE_EDIT_ROUTING,
    });
  });

  test("does not mutate the shared default routing table", () => {
    const first = materializeHashlineEditEntry(true);
    (first.routing as { rules: Record<string, string> }).rules.qwen = "hashline";
    const second = materializeHashlineEditEntry(true);
    expect((second.routing as { rules: Record<string, string> }).rules.qwen).toBe("replace");
    expect(DEFAULT_HASHLINE_EDIT_ROUTING.rules.qwen).toBe("replace");
  });
});
// END_BLOCK_MATERIALIZE_TESTS

// START_BLOCK_TOOL_HISTORY_MATERIALIZE_TESTS
describe("materializeToolHistoryCompactionEntry", () => {
  test("expands undefined and boolean entries to the full default entry", () => {
    expect(materializeToolHistoryCompactionEntry(undefined)).toEqual({
      ...DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY,
    });
    expect(materializeToolHistoryCompactionEntry(false)).toEqual({
      ...DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY,
      enabled: false,
    });
  });

  test("preserves user config keys that differ from defaults", () => {
    const custom = materializeToolHistoryCompactionEntry({
      enabled: true,
      readSlim: false,
      outputMaxChars: 4096,
    });
    expect(custom.readSlim).toBe(false);
    expect(custom.outputMaxChars).toBe(4096);
    expect(custom.protectLastCalls).toBe(DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY.protectLastCalls);
  });

  test("keeps enabled=false on an object entry", () => {
    expect(materializeToolHistoryCompactionEntry({ enabled: false }).enabled).toBe(false);
  });
});
// END_BLOCK_TOOL_HISTORY_MATERIALIZE_TESTS
