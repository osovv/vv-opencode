// FILE: src/plugins/v2-runtime/setup.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Dispatch the v2 setup(ctx) entry for the package root across the vvoc server plugins.
//   SCOPE: Central v2 registration seam only; individual plugin registrations attach here in later migration tasks, with per-plugin error isolation and aggregated cleanup disposal.
//   DEPENDS: [@opencode/plugin]
//   LINKS: [M-PLUGIN-V2-RUNTIME, V-M-PLUGIN-V2-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   setupV2Plugins - Run the v2 registrations for every vvoc server plugin against one full OpenCode v2 plugin context and return one aggregated cleanup; no-ops under the v1 v2-bridge host where the v1 runtime already calls server().
//   V2_PLUGIN_SETUPS - Ordered registry of per-plugin v2 setup functions extended by later migration tasks.
//   isFullV2Context - Feature-detect whether a setup context carries the full OpenCode v2 domain set.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION - Created the v2 setup dispatcher seam for the dual-runtime root entrypoint.]
// END_CHANGE_SUMMARY

import type { Plugin as V2Plugin } from "@opencode/plugin";

// START_BLOCK_V2_PLUGIN_SETUPS
/**
 * Per-plugin v2 setup functions in the canonical v1 plugin order. Later
 * migration tasks append entries as each plugin gains its v2 registration.
 */
export const V2_PLUGIN_SETUPS: Array<{
  name: string;
  setup: (context: V2Plugin.Context) => Promise<V2Plugin.Cleanup | void> | V2Plugin.Cleanup | void;
}> = [];
// END_BLOCK_V2_PLUGIN_SETUPS

// START_BLOCK_IS_FULL_V2_CONTEXT
/**
 * OpenCode v1 (>= 1.18.29) also invokes setup() on dual entrypoints through
 * its reduced v2 bridge host, whose context only carries the agent, aisdk,
 * catalog, command, integration, plugin, reference, and skill domains. The
 * full OpenCode v2 context additionally carries app, location, event, model,
 * provider, session, storage, tool, and the remaining runtime domains. Probe
 * verified against OpenCode 1.18.32: the v1 bridge lacks tool, session, event,
 * storage, app, and location, so their presence distinguishes the runtimes.
 */
export function isFullV2Context(context: V2Plugin.Context): boolean {
  const probe = context as unknown as Record<string, unknown>;
  return (
    "tool" in probe &&
    "session" in probe &&
    "event" in probe &&
    "storage" in probe &&
    "app" in probe &&
    "location" in probe
  );
}
// END_BLOCK_IS_FULL_V2_CONTEXT

// START_BLOCK_SETUP_V2_PLUGINS
/**
 * Run every registered v2 plugin setup against the context, isolating failures
 * per plugin, and return one cleanup that disposes the successful cleanups in
 * reverse registration order.
 *
 * Under the v1 v2-bridge host this returns without registering anything: the
 * same entrypoint's server() member already provides the v1 behavior, so the
 * package never registers twice inside one OpenCode v1 process.
 */
export async function setupV2Plugins(context: V2Plugin.Context): Promise<V2Plugin.Cleanup | void> {
  if (!isFullV2Context(context)) return undefined;
  const cleanups: Array<() => Promise<void> | void> = [];
  for (const entry of V2_PLUGIN_SETUPS) {
    try {
      const cleanup = await entry.setup(context);
      if (typeof cleanup === "function") {
        cleanups.push(cleanup);
      }
    } catch (error) {
      console.error(`[vvoc][v2-runtime] plugin ${entry.name} failed to load: ${String(error)}`);
    }
  }
  if (cleanups.length === 0) return undefined;
  return async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
  };
}
// END_BLOCK_SETUP_V2_PLUGINS
