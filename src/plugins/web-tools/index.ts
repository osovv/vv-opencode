// FILE: src/plugins/web-tools/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Register the canonical web_search and web_fetch tools, publish their strict input contracts through the owned definition seam, validate owned raw arguments before execution, and suppress OpenCode built-ins at runtime while the web-tools plugin is enabled.
//   SCOPE: Startup vvoc snapshot use, plugin toggle handling, runtime permission suppression, tool registration, owned contract publication and pre-execute validation for the two owned tool ids only, and credential-safe diagnostics. No interception of unrelated host or MCP tools.
//   DEPENDS: [@opencode-ai/plugin, src/lib/agent-tool-contract.ts, src/lib/config-layers.ts, src/lib/plugin-toggle-config.ts, src/plugins/web-tools/config.ts, src/plugins/web-tools/schemas.ts, src/plugins/web-tools/search-service.ts, src/plugins/web-tools/fetch-service.ts, src/plugins/v2-runtime/index.ts]
//   LINKS: M-PLUGIN-WEB-TOOLS, M-WEB-CONFIG, M-WEB-SEARCH-SERVICE, M-WEB-FETCH-SERVICE, M-AGENT-TOOL-CONTRACT, V-M-PLUGIN-WEB-TOOLS, DF-WEB-SEARCH, DF-WEB-FETCH
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SUPPRESSED_BUILTIN_PERMISSIONS - Built-in permission ids hidden while the plugin is enabled.
//   applyBuiltinSuppression - Add runtime-only deny rules unless the user configured a key explicitly.
//   WebToolsPlugin - Public plugin entry registering web_search and web_fetch.
//   default - Dual subpath entrypoint: v2 setup() seam plus v1 server() delegating to the named factory.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-001 - Added the dual subpath entrypoint so the plugin loads under OpenCode v1 via server() and v2 via setup(). Prior: C-AGENT-TOOL-CONTRACTS T-006 - Published both web tool contracts through the owned definition adapter and added an owned-only pre-execute guard; preserved built-in suppression, explicit user overrides, and disabled-plugin behavior.]
// END_CHANGE_SUMMARY

import { type Config, type Plugin } from "@opencode-ai/plugin";
import { ContractInputError, createToolDefinitionAdapter } from "../../lib/agent-tool-contract.js";
import { loadVvocConfig } from "../../lib/config-layers.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import { resolveWebRuntimeConfig, warnIfSecretBearingProjectConfigTracked } from "./config.js";
import { createWebFetchTool } from "./fetch-service.js";
import {
  WEB_FETCH_TOOL_ID,
  WEB_SEARCH_TOOL_ID,
  validateWebFetchToolInput,
  validateWebSearchToolInput,
  webToolContracts,
} from "./schemas.js";
import { createWebSearchTool } from "./search-service.js";

/** Built-in permission ids suppressed at runtime while web-tools is enabled. */
export const SUPPRESSED_BUILTIN_PERMISSIONS = ["webfetch", "websearch"] as const;

/**
 * Hide the built-in web tools by denying their permission keys in the merged runtime config.
 * Skips any key the user configured explicitly so explicit user policy always wins.
 * Mutates only the in-memory config object; no files are written.
 */
export function applyBuiltinSuppression(config: Config): void {
  config.permission ??= {};
  const permission = config.permission as Record<string, unknown>;
  for (const key of SUPPRESSED_BUILTIN_PERMISSIONS) {
    if (permission[key] === undefined) {
      permission[key] = "deny";
    }
  }
}

/**
 * WebToolsPlugin entry.
 * Disabled toggle: returns empty hooks and injects nothing.
 * Enabled: returns a config hook applying suppression and a tool map with exactly
 * web_search and web_fetch. Startup logs include provider names and credential sources
 * and never credential values; a git-tracked project config with an apiKey logs a warning
 * naming the file without the value.
 */
export const WebToolsPlugin: Plugin = async ({ client, directory }) => {
  const vvoc = await loadVvocConfig({ cwd: directory });
  if (!isVvocPluginEnabled(vvoc.config, "web-tools")) {
    return {};
  }

  const resolved = resolveWebRuntimeConfig(vvoc);
  await client.app.log({
    body: {
      service: "web-tools",
      level: "info",
      message: "web tools configuration loaded",
      extra: {
        searchProvider: resolved.search.provider,
        ...(resolved.search.provider === "zai" ? { searchRegion: resolved.search.region } : {}),
        searchCredentialSource: resolved.search.credential?.source ?? "missing",
        fetchProvider: resolved.fetch.provider,
        ...(resolved.fetch.provider === "zai" ? { fetchRegion: resolved.fetch.region } : {}),
        fetchCredentialSource:
          resolved.fetch.provider === "native"
            ? "not-required"
            : (resolved.fetch.credential?.source ?? "missing"),
      },
    },
  });

  for (const warning of resolved.warnings) {
    await client.app.log({
      body: { service: "web-tools", level: "warn", message: warning },
    });
  }

  const trackedConfigWarning = warnIfSecretBearingProjectConfigTracked(vvoc);
  if (trackedConfigWarning) {
    await client.app.log({
      body: { service: "web-tools", level: "warn", message: trackedConfigWarning },
    });
  }

  // Owned-only contract publication: the strict input JSON Schema is published through the
  // host's observable jsonSchema member without replacing the host decoder. Unowned tool ids
  // are left untouched.
  const toolDefinitionAdapter = createToolDefinitionAdapter([...webToolContracts]);

  return {
    config: async (config) => applyBuiltinSuppression(config),
    "tool.execute.before": async (input, output) => {
      // Validate only the two owned tool ids; every other host or MCP tool is untouched.
      const validation =
        input.tool === WEB_SEARCH_TOOL_ID
          ? validateWebSearchToolInput(output.args)
          : input.tool === WEB_FETCH_TOOL_ID
            ? validateWebFetchToolInput(output.args)
            : undefined;
      if (validation && !validation.ok) {
        throw new ContractInputError(input.tool, validation.issues);
      }
    },
    tool: {
      web_search: createWebSearchTool(resolved.search),
      web_fetch: createWebFetchTool(resolved.fetch),
    },
    "tool.definition": toolDefinitionAdapter,
  };
};

// START_BLOCK_DUAL_SUBPATH_ENTRY
import { defineDualPlugin } from "../v2-runtime/index.js";

export default defineDualPlugin({
  id: "vvoc.web-tools",
  v1: WebToolsPlugin,
  v2: async () => {},
});
// END_BLOCK_DUAL_SUBPATH_ENTRY
