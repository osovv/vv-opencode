// FILE: src/lib/plugin-toggle-config.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the canonical plugin toggle names, default-all-true values, a shared VvocPluginToggleConfig type, and the isPluginEnabled() helper that each plugin factory calls at load time.
//   SCOPE: Plugin name constants, default config builder, runtime toggle check from the effective vvoc config source, and the toggle config type.
//   DEPENDS: [src/lib/config-layers.ts]
//   LINKS: [M-PLUGIN-TOGGLE-CONFIG, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PLUGIN_TOGGLE_NAMES - Canonical list of vvoc-managed plugin names.
//   VvocPluginToggleConfig - Type alias for Record<string, boolean>.
//   createDefaultPluginToggleConfig - Returns a Record with all known plugins set to true.
//   isPluginEnabled - Read the effective vvoc config source and return whether the named plugin is enabled.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.0 - Loaded plugin toggles from the effective vvoc config source.]
//   LAST_CHANGE: [v1.0.0 - Initial implementation for runtime plugin toggle.]
// END_CHANGE_SUMMARY

import { loadEffectiveVvocConfigForRuntime } from "./config-layers.js";

// START_BLOCK_CONSTANTS
export const PLUGIN_TOGGLE_NAMES = [
  "guardian",
  "hashline-edit",
  "model-roles",
  "system-context-injection",
  "workflow",
  "secrets-redaction",
] as const;

export type VvocPluginToggleConfig = Record<string, boolean>;
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

// START_BLOCK_IS_PLUGIN_ENABLED
// START_CONTRACT: isPluginEnabled
//   PURPOSE: Read the effective vvoc config source and return whether the named plugin is enabled.
//   INPUTS: { pluginName: string - one of PLUGIN_TOGGLE_NAMES }
//   OUTPUTS: { boolean - true if the plugin is enabled or the plugins section is absent, false if explicitly disabled }
//   SIDE_EFFECTS: Reads vvoc.json from the effective config source on each call.
//   LINKS: loadEffectiveVvocConfigForRuntime
// END_CONTRACT: isPluginEnabled
export async function isPluginEnabled(
  pluginName: string,
  options: { cwd?: string; configDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  // START_BLOCK_VALIDATE_INPUT
  // END_BLOCK_VALIDATE_INPUT

  const loaded = await loadEffectiveVvocConfigForRuntime(options);
  const pluginValue = loaded.config.plugins[pluginName];
  // If the specific plugin is not listed, default to enabled
  if (typeof pluginValue !== "boolean") {
    return true;
  }

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
// END_BLOCK_IS_PLUGIN_ENABLED
