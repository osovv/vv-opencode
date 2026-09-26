// FILE: src/plugins/v2-runtime/setup.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Dispatch the v2 setup(ctx) entry for the package root across the vvoc server plugins through a shared adapter carrying per-location config resolution and config watching.
//   SCOPE: Central v2 registration seam: the adapter context (plugin context, location resolver, config watch helper), the ordered plugin setup registry, full-v2-context feature detection, per-plugin error isolation, and aggregated reverse-order cleanup disposal.
//   DEPENDS: [@opencode/plugin, src/plugins/v2-runtime/location-config.ts, src/plugins/v2-runtime/config-watcher.ts]
//   LINKS: [M-PLUGIN-V2-RUNTIME, V-M-PLUGIN-V2-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   setupV2Plugins - Run the v2 registrations for every vvoc server plugin against one full OpenCode v2 plugin context and return one aggregated cleanup; no-ops under the v1 v2-bridge host where the v1 runtime already calls server().
//   V2_PLUGIN_SETUPS - Ordered registry of per-plugin v2 setup functions extended by later migration tasks.
//   V2AdapterContext - Plugin context plus the location resolver and multiplexed config watcher shared by all vvoc plugins.
//   createV2Adapter - Build the shared adapter context with the location resolver and multiplexed config watcher.
//   isFullV2Context - Feature-detect whether a setup context carries the full OpenCode v2 domain set.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-002 - Plugin setups now receive the shared adapter context with per-location config resolution and config watching.]
// END_CHANGE_SUMMARY

import type { Plugin as V2Plugin } from "@opencode/plugin";
import { createLocationResolver, type LocationResolver } from "./location-config.js";
import { watchProjectVvocConfig } from "./config-watcher.js";
import { setupAnalyticsV2 } from "../analytics/v2.js";
import { setupSystemContextInjectionV2 } from "../system-context-injection/v2.js";
import { setupModelRolesV2 } from "../model-roles/v2.js";
import { setupToolHistoryCompactionV2 } from "../tool-history-compaction/v2.js";
import { setupSpecGuardV2 } from "../spec-guard/v2.js";
import { setupSecretsRedactionV2 } from "../secrets-redaction/v2.js";
import { setupPeakHoursV2 } from "../peak-hours/v2.js";
import { setupWebToolsV2 } from "../web-tools/v2.js";
import { setupHashlineEditV2 } from "../hashline-edit/v2.js";
import { setupGuardianV2 } from "../guardian/v2.js";

// START_BLOCK_V2_ADAPTER_CONTEXT
/**
 * The context handed to every vvoc plugin v2 setup: the OpenCode v2 plugin
 * context plus the shared location resolver and a multiplexed config watcher.
 */
export interface V2AdapterContext {
  readonly ctx: V2Plugin.Context;
  readonly resolver: LocationResolver;
  /** Watch the project vvoc config effective for one directory; the returned stop function never throws. */
  watchConfig(directory: string, onChange: () => void): Promise<() => void>;
}

type V2PluginSetup = (
  adapter: V2AdapterContext,
) => Promise<V2Plugin.Cleanup | void> | V2Plugin.Cleanup | void;
// END_BLOCK_V2_ADAPTER_CONTEXT

// START_BLOCK_V2_PLUGIN_SETUPS
/**
 * Per-plugin v2 setup functions in the canonical v1 plugin order. Migration
 * tasks append entries as each plugin gains its v2 registration.
 */
export const V2_PLUGIN_SETUPS: Array<{
  name: string;
  setup: V2PluginSetup;
}> = [
  { name: "analytics", setup: (adapter) => setupAnalyticsV2(adapter) },
  { name: "system-context-injection", setup: (adapter) => setupSystemContextInjectionV2(adapter) },
  { name: "model-roles", setup: (adapter) => setupModelRolesV2(adapter) },
  { name: "tool-history-compaction", setup: (adapter) => setupToolHistoryCompactionV2(adapter) },
  { name: "spec-guard", setup: (adapter) => setupSpecGuardV2(adapter) },
  { name: "secrets-redaction", setup: (adapter) => setupSecretsRedactionV2(adapter) },
  { name: "peak-hours", setup: (adapter) => setupPeakHoursV2(adapter) },
  { name: "web-tools", setup: (adapter) => setupWebToolsV2(adapter) },
  { name: "hashline-edit", setup: (adapter) => setupHashlineEditV2(adapter) },
  { name: "guardian", setup: (adapter) => setupGuardianV2(adapter) },
];
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

// START_BLOCK_CREATE_ADAPTER
/**
 * Build the shared adapter for one plugin context: a per-location config
 * resolver and a config watcher multiplexer that keeps one filesystem watch
 * per directory regardless of how many plugins subscribe to that directory.
 */
export function createV2Adapter(context: V2Plugin.Context): V2AdapterContext {
  const resolver = createLocationResolver();
  const subscriptions = new Map<string, Map<symbol, () => void>>();
  const activeWatches = new Map<string, () => void>();

  async function ensureWatched(directory: string): Promise<void> {
    if (activeWatches.has(directory)) return;
    const listeners = subscriptions.get(directory);
    if (!listeners || listeners.size === 0) return;
    const stopWatch = await watchProjectVvocConfig(directory, () => {
      resolver.invalidate(directory);
      for (const listener of listeners.values()) {
        try {
          listener();
        } catch (error) {
          console.warn(
            `[vvoc][v2-runtime] config listener failed for ${directory}: ${String(error)}`,
          );
        }
      }
    });
    activeWatches.set(directory, stopWatch);
  }

  return {
    ctx: context,
    resolver,
    async watchConfig(directory, onChange) {
      const key = Symbol("vvoc-config-listener");
      let listeners = subscriptions.get(directory);
      if (!listeners) {
        listeners = new Map();
        subscriptions.set(directory, listeners);
      }
      listeners.set(key, onChange);
      await ensureWatched(directory);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        const current = subscriptions.get(directory);
        if (!current) return;
        current.delete(key);
        if (current.size === 0) {
          subscriptions.delete(directory);
          const stopWatch = activeWatches.get(directory);
          if (stopWatch) {
            activeWatches.delete(directory);
            stopWatch();
          }
        }
      };
    },
  };
}
// END_BLOCK_CREATE_ADAPTER

// START_BLOCK_SETUP_V2_PLUGINS
/**
 * Run every registered v2 plugin setup against the adapter, isolating failures
 * per plugin, and return one cleanup that disposes the successful cleanups in
 * reverse registration order.
 *
 * Under the v1 v2-bridge host this returns without registering anything: the
 * same entrypoint's server() member already provides the v1 behavior, so the
 * package never registers twice inside one OpenCode v1 process.
 */
export async function setupV2Plugins(context: V2Plugin.Context): Promise<V2Plugin.Cleanup | void> {
  if (!isFullV2Context(context)) return undefined;
  const adapter = createV2Adapter(context);
  const cleanups: Array<() => Promise<void> | void> = [];
  for (const entry of V2_PLUGIN_SETUPS) {
    try {
      const cleanup = await entry.setup(adapter);
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
