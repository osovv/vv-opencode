// FILE: src/lib/plugin-toggle-config.ts
// VERSION: 1.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Define canonical plugin toggle names, default-all-true values, and a pure plugin-enabled helper for loaded vvoc config snapshots.
//   SCOPE: Plugin name constants, default config builder, default hashline edit-routing table, conservative hashline-edit entry materialization, pure toggle checks, and the toggle config type.
//   DEPENDS: [none]
//   LINKS: [M-PLUGIN-TOGGLE-CONFIG, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PLUGIN_TOGGLE_NAMES - Canonical list of vvoc-managed plugin names.
//   VvocPluginToggleConfig - Type alias mapping plugin names to boolean toggles or object entries.
//   VvocPluginEntryConfig - Object-form plugin entry with optional enabled flag and plugin-owned routing config.
//   createDefaultPluginToggleConfig - Returns a Record with all known plugins set to true.
//   DEFAULT_HASHLINE_EDIT_ROUTING - Default edit-routing table materialized into vvoc.json for the hashline-edit plugin.
//   materializeHashlineEditEntry - Expand the hashline-edit entry so the routing table is present without overwriting user values.
//   isPluginEnabled - Returns whether the named plugin is enabled in a loaded vvoc config object.
//   isVvocPluginEnabled - Alias for isPluginEnabled with explicit vvoc naming.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.4.0 - Added the default hashline edit-routing table and conservative materialization of the hashline-edit plugin entry for vvoc sync/init.]
// END_CHANGE_SUMMARY

// START_BLOCK_CONSTANTS
export const PLUGIN_TOGGLE_NAMES = [
  "guardian",
  "hashline-edit",
  "model-roles",
  "system-context-injection",
  "workflow",
  "secrets-redaction",
  "context",
  "web-tools",
] as const;

export type VvocPluginEntryConfig = {
  enabled?: boolean;
  routing?: Record<string, unknown>;
};

export type VvocPluginToggleConfig = Record<string, boolean | VvocPluginEntryConfig>;

// Default edit-routing table for the hashline-edit plugin. Materialized into vvoc.json
// on sync/init so it is visible and editable; kept as a plain config-shape object
// (rules as a pattern->mode record). The plugin converts it to its runtime form.
export const DEFAULT_HASHLINE_EDIT_ROUTING = {
  default: "hashline",
  rules: {
    deepseek: "str_replace_editor",
    kimi: "replace",
    qwen: "replace",
    glm: "replace",
    gpt: "passthrough",
    codex: "passthrough",
  },
} as const;
// END_BLOCK_CONSTANTS

// START_BLOCK_DEFAULT_CONFIG
export function createDefaultPluginToggleConfig(): VvocPluginToggleConfig {
  const config: VvocPluginToggleConfig = {};
  for (const name of PLUGIN_TOGGLE_NAMES) {
    config[name] = true;
  }
  return config;
}
// END_BLOCK_DEFAULT_CONFIG

// START_BLOCK_HASHLINE_ROUTING_MATERIALIZE
function defaultHashlineRoutingCopy(): Record<string, unknown> {
  return {
    default: DEFAULT_HASHLINE_EDIT_ROUTING.default,
    rules: { ...DEFAULT_HASHLINE_EDIT_ROUTING.rules },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Materialize the hashline-edit plugin entry so the edit-routing table is always
 * present in vvoc.json. Conservative: a user value that differs from the default
 * is never overwritten. Boolean or missing entries expand to the full object with
 * the default routing table; object entries keep their enabled flag and routing
 * block when present, filling routing with the default only when it is absent.
 */
export function materializeHashlineEditEntry(
  current: boolean | VvocPluginEntryConfig | undefined,
): VvocPluginEntryConfig {
  if (current === undefined || typeof current === "boolean") {
    return {
      enabled: current === undefined ? true : current,
      routing: defaultHashlineRoutingCopy(),
    };
  }

  const materialized: VvocPluginEntryConfig = {
    enabled: current.enabled ?? true,
  };
  materialized.routing = isPlainRecord(current.routing)
    ? current.routing
    : defaultHashlineRoutingCopy();
  return materialized;
}
// END_BLOCK_HASHLINE_ROUTING_MATERIALIZE

// START_CONTRACT: isPluginEnabled
//   PURPOSE: Return whether the named plugin is enabled in an already-loaded vvoc config.
//   INPUTS: { config: { plugins?: VvocPluginToggleConfig } - loaded vvoc config or compatible plugin toggle holder; pluginName: string - one of PLUGIN_TOGGLE_NAMES }
//   OUTPUTS: { boolean - true if the plugin is enabled or the plugins section is absent, false if explicitly disabled }
//   SIDE_EFFECTS: none
//   LINKS: loadVvocConfig
// END_CONTRACT: isPluginEnabled
// START_BLOCK_VALIDATE_INPUT
export function isPluginEnabled(
  config: { plugins?: VvocPluginToggleConfig },
  pluginName: string,
): boolean {
  // END_BLOCK_VALIDATE_INPUT
  // START_BLOCK_IS_PLUGIN_ENABLED

  const pluginValue = config.plugins?.[pluginName];
  // If the specific plugin is not listed, default to enabled
  if (pluginValue === undefined) {
    return true;
  }

  if (typeof pluginValue === "boolean") {
    if (process.env.DEBUG?.includes("vvoc")) {
      console.log(
        "[plugin-toggle][isPluginEnabled][BLOCK_CHECK_PLUGIN_ENABLED] plugin " +
          pluginName +
          " enabled: " +
          pluginValue,
      );
    }
    return pluginValue;
  }

  // Object entry: enabled defaults to true; plugin-owned sections do not disable it.
  return pluginValue.enabled !== false;
}

export const isVvocPluginEnabled = isPluginEnabled;
// END_BLOCK_IS_PLUGIN_ENABLED
