// FILE: src/commands/plugin-list.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Display all installed OpenCode plugins with their status (enabled/disabled) and source paths.
//   SCOPE: Scope parsing, plugin array inspection, table rendering, and graceful handling of missing config.
//   DEPENDS: [citty, node:fs/promises, src/lib/opencode.js, src/lib/plugin-toggle-config.js]
//   LINKS: [M-CLI-PLUGIN-LIST, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - PluginList command definition for vvoc.
//   listPlugins - Returns the list of plugins from OpenCode config.
//   renderPluginTable - Renders a table of plugins with name, source, and enabled status.
//   PluginEntry - Parsed plugin entry information.
//   parsePluginSpecifier - Parse plugin specifier string.
//   loadVvocPluginToggles - Read plugin toggle state from vvoc.json.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.0 - Initial GRACE implementation for plugin list command.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { resolvePaths, type Scope } from "../lib/opencode.js";
import { readFile } from "node:fs/promises";
import { getGlobalVvocConfigPath } from "../lib/vvoc-paths.js";

export type PluginEntry = {
  name: string;
  source: string;
  enabled: boolean;
};

export default defineCommand({
  meta: {
    name: "list",
    description: "List installed OpenCode plugins.",
  },
  args: {
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "List plugins from global or project config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home used for opencode/",
    },
    verbose: {
      type: "boolean",
      default: false,
      description: "Show additional details including config path.",
    },
  },
  async run({ args }) {
    // START_BLOCK_RUN_PLUGIN_LIST
    const scope = args.scope === "project" ? "project" : "global";
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const verbose = args.verbose === true;
    const cwd = process.cwd();

    const paths = await resolvePaths({ scope, cwd, configDir });
    const plugins = await listPlugins(scope, cwd, configDir);

    if (verbose) {
      console.log(`Scope: ${scope}`);
      console.log(`OpenCode config: ${paths.opencodeConfigPath}`);
    }

    const vvocToggles = await loadVvocPluginToggles();
    renderPluginTable(plugins, vvocToggles);
    // END_BLOCK_RUN_PLUGIN_LIST
  },
});

export async function listPlugins(
  scope: Scope,
  cwd: string,
  configDir?: string,
): Promise<PluginEntry[]> {
  const paths = await resolvePaths({ scope, cwd, configDir });

  try {
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(paths.opencodeConfigPath, "utf8");
    const { parse } = await import("jsonc-parser");
    const errors: import("jsonc-parser").ParseError[] = [];
    const parsed = parse(content, errors, { allowTrailingComma: true, disallowComments: false });

    if (errors.length > 0 || typeof parsed !== "object" || parsed === null) {
      return [];
    }

    const obj = parsed as Record<string, unknown>;
    const pluginField = obj.plugin;

    if (!Array.isArray(pluginField)) {
      return [];
    }

    return pluginField
      .filter((entry): entry is string => typeof entry === "string")
      .map((specifier) => parsePluginSpecifier(specifier));
  } catch {
    return [];
  }
}

export function parsePluginSpecifier(specifier: string): PluginEntry {
  const enabled = !specifier.startsWith("#");
  const source = specifier.replace(/^#/, "").trim();

  const lastSlash = source.lastIndexOf("/");
  const versionIdx = lastSlash >= 0 ? source.indexOf("@", lastSlash + 1) : source.indexOf("@");
  const nameSource = versionIdx > 0 ? source.slice(0, versionIdx) : source;

  let name = nameSource;
  if (nameSource.startsWith("@")) {
    const parts = nameSource.split("/");
    if (parts.length >= 2) {
      name = `${parts[0]}/${parts[1]}`;
    }
  } else if (nameSource.includes("/")) {
    const idx = nameSource.lastIndexOf("/");
    name = nameSource.slice(idx + 1);
  }

  return { name, source, enabled };
}

export async function loadVvocPluginToggles(): Promise<Record<string, boolean> | null> {
  try {
    const configPath = getGlobalVvocConfigPath();
    const content = await readFile(configPath, "utf8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.plugins !== "object" || parsed.plugins === null) {
      return null;
    }
    return parsed.plugins as Record<string, boolean>;
  } catch {
    return null;
  }
}

export function renderPluginTable(
  plugins: PluginEntry[],
  vvocToggles: Record<string, boolean> | null = null,
): void {
  if (plugins.length === 0) {
    console.log("No plugins configured.");
    return;
  }

  const nameCol = "Name";
  const sourceCol = "Source";
  const statusCol = "Status";

  const nameWidth = Math.max(nameCol.length, ...plugins.map((p) => p.name.length));
  const sourceWidth = Math.max(sourceCol.length, ...plugins.map((p) => p.source.length));

  const header = `  ${nameCol.padEnd(nameWidth)}  ${sourceCol.padEnd(sourceWidth)}  ${statusCol}`;
  const separator = `  ${"-".repeat(nameWidth)}  ${"-".repeat(sourceWidth)}  ${"-".repeat(6)}`;

  console.log(header);
  console.log(separator);

  for (const plugin of plugins) {
    const status = plugin.enabled ? "enabled" : "disabled";
    console.log(
      `  ${plugin.name.padEnd(nameWidth)}  ${plugin.source.padEnd(sourceWidth)}  ${status}`,
    );
  }

  // Render VVoc plugin toggles section
  if (vvocToggles !== null) {
    console.log();
    console.log("VVoc Plugin Toggles:");
    const toggleNameCol = "Plugin";
    const toggleStatusCol = "Status";
    const toggleNameWidth = Math.max(
      toggleNameCol.length,
      ...(Object.keys(vvocToggles).length > 0
        ? Object.keys(vvocToggles).map((n) => n.length)
        : [0]),
    );
    const toggleHeader = `  ${toggleNameCol.padEnd(toggleNameWidth)}  ${toggleStatusCol}`;
    const toggleSep = `  ${"-".repeat(toggleNameWidth)}  ${"-".repeat(9)}`;
    console.log(toggleHeader);
    console.log(toggleSep);
    for (const [pluginName, enabled] of Object.entries(vvocToggles)) {
      const statusText = enabled ? "enabled" : "disabled";
      console.log(`  ${pluginName.padEnd(toggleNameWidth)}  ${statusText}`);
    }
  }
}
