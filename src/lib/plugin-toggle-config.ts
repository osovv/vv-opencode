// FILE: src/lib/plugin-toggle-config.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the canonical plugin toggle names, default-all-true values, a shared VvocPluginToggleConfig type, and the isPluginEnabled() helper that each plugin factory calls at load time.
//   SCOPE: Plugin name constants, default config builder, runtime toggle check from vvoc.json, and the toggle config type.
//   DEPENDS: [node:fs/promises, src/lib/vvoc-paths.js]
//   LINKS: [M-PLUGIN-TOGGLE-CONFIG, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PLUGIN_TOGGLE_NAMES - Canonical list of vvoc-managed plugin names.
//   VvocPluginToggleConfig - Type alias for Record<string, boolean>.
//   createDefaultPluginToggleConfig - Returns a Record with all known plugins set to true.
//   isPluginEnabled - Read canonical vvoc.json and return whether the named plugin is enabled.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial implementation for runtime plugin toggle.]
// END_CHANGE_SUMMARY

import { readFile } from "node:fs/promises";
import { getGlobalVvocConfigPath } from "./vvoc-paths.js";

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
//   PURPOSE: Read canonical vvoc.json and return whether the named plugin is enabled.
//   INPUTS: { pluginName: string - one of PLUGIN_TOGGLE_NAMES }
//   OUTPUTS: { boolean - true if the plugin is enabled or the plugins section is absent, false if explicitly disabled }
//   SIDE_EFFECTS: Reads vvoc.json from the canonical global config path on each call.
//   LINKS: getGlobalVvocConfigPath
// END_CONTRACT: isPluginEnabled
export async function isPluginEnabled(pluginName: string): Promise<boolean> {
  // START_BLOCK_VALIDATE_INPUT
  // END_BLOCK_VALIDATE_INPUT

  try {
    const configPath = getGlobalVvocConfigPath();
    const content = await readFile(configPath, "utf8");
    const parsed = JSON.parse(content) as Record<string, unknown>;

    // If the plugins section is absent, default to enabled (backward compatibility)
    const plugins = parsed.plugins;
    if (typeof plugins !== "object" || plugins === null) {
      return true;
    }

    const pluginValue = (plugins as Record<string, unknown>)[pluginName];
    // If the specific plugin is not listed, default to enabled
    if (typeof pluginValue !== "boolean") {
      return true;
    }

    return pluginValue;
  } catch {
    // If config cannot be read or parsed, default to enabled
    return true;
  }
}
// END_BLOCK_IS_PLUGIN_ENABLED
