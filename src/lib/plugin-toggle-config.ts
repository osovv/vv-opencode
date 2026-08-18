// FILE: src/lib/plugin-toggle-config.ts
// VERSION: 1.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Define canonical plugin toggle names, default-all-true values, and a pure plugin-enabled helper for loaded vvoc config snapshots.
//   SCOPE: Plugin name constants, default config builder, pure toggle checks, and the toggle config type.
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
//   isPluginEnabled - Returns whether the named plugin is enabled in a loaded vvoc config object.
//   isVvocPluginEnabled - Alias for isPluginEnabled with explicit vvoc naming.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.3.0 - Plugin entries accept an object form with optional enabled flag and plugin-owned config; isPluginEnabled resolves both forms.]
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
