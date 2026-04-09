// FILE: src/commands/plugin-list.ts
// VERSION: 0.5.0
// START_MODULE_CONTRACT
//   PURPOSE: Display all installed OpenCode plugins with their status (enabled/disabled) and source paths.
//   SCOPE: Global plugin array inspection, table rendering, and graceful handling of missing config.
//   DEPENDS: [citty, src/lib/opencode.js]
//   LINKS: [M-CLI-PLUGIN-LIST, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - PluginList command definition for vvoc.
//   listPlugins - Returns the list of plugins from OpenCode config.
//   renderPluginTable - Renders a table of plugins with name, source, and enabled status.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.5.0 - Removed scope/config-dir flags from plugin list output and target the global OpenCode config.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { resolvePaths } from "../lib/opencode.js";

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
    verbose: {
      type: "boolean",
      default: false,
      description: "Show additional details including config path.",
    },
  },
  async run({ args }) {
    // START_BLOCK_RUN_PLUGIN_LIST
    const verbose = args.verbose === true;

    const paths = await resolvePaths();
    const plugins = await listPlugins();

    if (verbose) {
      console.log(`OpenCode config: ${paths.opencodeConfigPath}`);
    }

    renderPluginTable(plugins);
    // END_BLOCK_RUN_PLUGIN_LIST
  },
});

export async function listPlugins(configDir?: string): Promise<PluginEntry[]> {
  const paths = await resolvePaths({ configDir });

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

export function renderPluginTable(plugins: PluginEntry[]): void {
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
}
