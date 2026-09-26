// FILE: src/plugins/web-tools/v2.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Register the canonical web_search and web_fetch tools on the OpenCode v2 runtime, overriding the built-ins while the plugin is enabled.
//   SCOPE: v2 setup only: publish both owned tools with their strict JSON Schema inputs through the tool transform, adapt the shared executors to the v2 executor contract with cooperative cancellation through the context signal, resolve credentials per plugin-load location, and leave unowned tool ids untouched.
//   DEPENDS: [@opencode/plugin, src/lib/agent-tool-contract.ts, src/lib/config-layers.ts, src/plugins/web-tools/config.ts, src/plugins/web-tools/fetch-service.ts, src/plugins/web-tools/schemas.ts, src/plugins/web-tools/search-service.ts, src/plugins/v2-runtime/setup.ts]
//   LINKS: [M-PLUGIN-WEB-TOOLS, V-M-PLUGIN-WEB-TOOLS, M-PLUGIN-V2-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   setupWebToolsV2 - Register both web tools for one OpenCode v2 plugin context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-004 - Ported web tools onto the v2 tool transform with built-in override semantics.]
// END_CHANGE_SUMMARY

import type { Plugin as V2Plugin } from "@opencode/plugin";
import type { V2AdapterContext } from "../v2-runtime/setup.js";
import { loadVvocConfigForRead } from "../../lib/config-layers.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import { resolveWebRuntimeConfig } from "./config.js";
import { createWebFetchTool } from "./fetch-service.js";
import { createWebSearchTool } from "./search-service.js";
import { webToolContracts } from "./schemas.js";

// START_BLOCK_ADAPT_V1_EXECUTOR
/**
 * Adapt one v1 tool executor invocation to the v2 Tool.Result shape.
 *
 * The v1 executors validate their own arguments, ask for permission through
 * the v1 ask() surface (v2 gates these tools through session permission rules
 * instead), and return { title, output, metadata }; the adapter forwards the
 * cancellation signal and maps the output to the v2 content string.
 */
function adaptV1Executor(execute: (args: unknown, context: unknown) => Promise<unknown>) {
  return async (input: unknown, context: { signal?: AbortSignal }) => {
    const result = (await execute(input, {
      ask: async () => {},
      abort: context.signal,
    } as never)) as
      | { title?: string; output?: string; metadata?: Record<string, unknown> }
      | string;
    if (typeof result === "string") {
      return { content: result };
    }
    return {
      ...(result?.title ? { title: result.title } : {}),
      content: result?.output ?? "",
      ...(result?.metadata ? { metadata: result.metadata } : {}),
    };
  };
}
// END_BLOCK_ADAPT_V1_EXECUTOR

// START_BLOCK_SETUP_WEB_TOOLS_V2
/**
 * Register the web tools on the v2 runtime.
 *
 * A later valid tool registration overrides the same effective name, so
 * registering web_search and web_fetch replaces the OpenCode built-ins while
 * the plugin is enabled and disposing the registration restores them, which
 * replaces the v1 config-hook builtin suppression.
 */
export async function setupWebToolsV2(adapter: V2AdapterContext): Promise<V2Plugin.Cleanup | void> {
  const directory = adapter.ctx.location.directory;
  const read = await loadVvocConfigForRead({
    cwd: directory,
    scope: "effective",
    allowDefault: true,
  });
  if (!isVvocPluginEnabled(read.config, "web-tools")) return undefined;

  const resolved = resolveWebRuntimeConfig({
    config: read.config,
    source: read.source,
    warnings: read.warnings,
  } as never);
  const searchContract = webToolContracts.find((contract) => contract.toolId === "web_search");
  const fetchContract = webToolContracts.find((contract) => contract.toolId === "web_fetch");
  if (!searchContract || !fetchContract) {
    console.error("[vvoc][web-tools] owned tool contracts missing; v2 registration skipped");
    return undefined;
  }

  const searchTool = createWebSearchTool(resolved.search);
  const fetchTool = createWebFetchTool(resolved.fetch);

  const registration = await adapter.ctx.tool.transform((editor) => {
    editor.add({
      name: "web_search",
      description: "Search the web with the configured provider and return ranked results.",
      input: searchContract.inputJsonSchema as never,
      execute: adaptV1Executor(searchTool.execute as never) as never,
    });
    editor.add({
      name: "web_fetch",
      description: "Fetch one URL and return its content as markdown.",
      input: fetchContract.inputJsonSchema as never,
      execute: adaptV1Executor(fetchTool.execute as never) as never,
    });
  });

  return () => registration.dispose();
}
// END_BLOCK_SETUP_WEB_TOOLS_V2
