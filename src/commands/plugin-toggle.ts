// FILE: src/commands/plugin-toggle.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide `vvoc plugin enable <name>` and `vvoc plugin disable <name>` subcommands that mutate the `plugins` section in canonical vvoc.json.
//   SCOPE: Plugin name validation, vvoc.json read/write, and CLI output.
//   DEPENDS: [citty, node:fs/promises, src/lib/opencode.js, src/lib/plugin-toggle-config.js]
//   LINKS: [M-CLI-PLUGIN-TOGGLE, M-CLI-CONFIG, M-PLUGIN-TOGGLE-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   enableCommand - Enable plugin subcommand definition.
//   disableCommand - Disable plugin subcommand definition.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial implementation for runtime plugin enable/disable.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { readFile, writeFile } from "node:fs/promises";
import { resolvePaths } from "../lib/opencode.js";
import { PLUGIN_TOGGLE_NAMES } from "../lib/plugin-toggle-config.js";
import type { Scope } from "../lib/opencode.js";

// START_BLOCK_TOGGLE_PLUGIN
async function togglePlugin(
  pluginName: string,
  enabled: boolean,
  scope: Scope,
  cwd: string,
  configDir?: string,
): Promise<string> {
  const paths = await resolvePaths({ scope, cwd, configDir });

  // Read current vvoc.json
  let content: string;
  try {
    content = await readFile(paths.vvocConfigPath, "utf8");
  } catch {
    throw new Error(`Cannot read vvoc config at ${paths.vvocConfigPath}`);
  }

  const config = JSON.parse(content) as Record<string, unknown>;

  // Ensure plugins section exists
  if (typeof config.plugins !== "object" || config.plugins === null) {
    config.plugins = {};
  }

  const plugins = config.plugins as Record<string, unknown>;
  plugins[pluginName] = enabled;

  await writeFile(paths.vvocConfigPath, JSON.stringify(config, null, 2) + "\n", "utf8");

  const state = enabled ? "enabled" : "disabled";
  return `Plugin "${pluginName}" ${state}. Restart the session to apply.`;
}
// END_BLOCK_TOGGLE_PLUGIN

// START_BLOCK_ENABLE_COMMAND
export const enableCommand = defineCommand({
  meta: {
    name: "enable",
    description: "Enable a vvoc-managed plugin.",
  },
  args: {
    plugin: {
      type: "positional",
      description: "Plugin name to enable (e.g. secrets-redaction, hashline-edit).",
      required: true,
    },
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Config scope.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home.",
    },
  },
  async run({ args }) {
    const pluginName = args.plugin as string;
    const scope = (args.scope === "project" ? "project" : "global") as Scope;
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const cwd = process.cwd();

    if (!PLUGIN_TOGGLE_NAMES.includes(pluginName as (typeof PLUGIN_TOGGLE_NAMES)[number])) {
      console.error(
        `Unknown plugin "${pluginName}". Available plugins: ${PLUGIN_TOGGLE_NAMES.join(", ")}`,
      );
      process.exit(1);
    }

    try {
      const message = await togglePlugin(pluginName, true, scope, cwd, configDir);
      console.log(message);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  },
});
// END_BLOCK_ENABLE_COMMAND

// START_BLOCK_DISABLE_COMMAND
export const disableCommand = defineCommand({
  meta: {
    name: "disable",
    description: "Disable a vvoc-managed plugin until re-enabled.",
  },
  args: {
    plugin: {
      type: "positional",
      description: "Plugin name to disable (e.g. secrets-redaction, hashline-edit).",
      required: true,
    },
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Config scope.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home.",
    },
  },
  async run({ args }) {
    const pluginName = args.plugin as string;
    const scope = (args.scope === "project" ? "project" : "global") as Scope;
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const cwd = process.cwd();

    if (!PLUGIN_TOGGLE_NAMES.includes(pluginName as (typeof PLUGIN_TOGGLE_NAMES)[number])) {
      console.error(
        `Unknown plugin "${pluginName}". Available plugins: ${PLUGIN_TOGGLE_NAMES.join(", ")}`,
      );
      process.exit(1);
    }

    try {
      const message = await togglePlugin(pluginName, false, scope, cwd, configDir);
      console.log(message);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  },
});
// END_BLOCK_DISABLE_COMMAND
