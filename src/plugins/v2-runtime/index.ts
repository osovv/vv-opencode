// FILE: src/plugins/v2-runtime/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide the dual-runtime plugin foundation that lets one package entrypoint serve OpenCode v1 (server() object entrypoints, >= 1.18.29) and OpenCode v2 (Plugin.define setup, >= 2.0.18) without double registration.
//   SCOPE: Dual entrypoint construction with stable plugin ids, sequential v1 plugin aggregation with per-plugin error isolation, hook-object merging that preserves v1 trigger and dispose ordering, and the typed seams later tasks use to attach v2 domain registrations.
//   DEPENDS: [@opencode/plugin, @opencode-ai/plugin]
//   LINKS: [M-PLUGIN-V2-RUNTIME, V-M-PLUGIN-V2-RUNTIME, M-PLUGIN-GUARDIAN, M-PLUGIN-WORKFLOW]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   defineDualPlugin - Build a dual entrypoint whose default export serves v2 via setup(ctx) and v1 via server(input, options).
//   mergeV1Hooks - Merge v1 hook objects into one object that runs each hook key sequentially in registration order and disposes in the same order.
//   DualPlugin - Type of the dual entrypoint: v2 Plugin shape plus the v1 server() member.
//   V2Setup - Signature of a v2 setup function receiving the v2 plugin Context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION - Created the dual-runtime foundation so every package entrypoint loads under both OpenCode runtimes.]
// END_CHANGE_SUMMARY

import { Plugin as V2Plugin } from "@opencode/plugin";
import type { Hooks, Plugin as V1Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";

// START_BLOCK_DUAL_PLUGIN_TYPE
/**
 * The v2 setup signature, including an optional cleanup return.
 */
export type V2Setup = (
  context: V2Plugin.Context,
) => Promise<V2Plugin.Cleanup | void> | V2Plugin.Cleanup | void;

/**
 * A dual-runtime plugin entrypoint: the v2 Plugin shape (id + setup) plus the
 * v1 object-entrypoint server() member. OpenCode v1 (>= 1.18.29) detects the
 * default export through its id/server members and calls only server(); OpenCode
 * v2 reads id and setup() and ignores server(). Neither runtime loads the other
 * path, so a package exposing exactly this default export registers once.
 */
export type DualPlugin = V2Plugin.Plugin & {
  server: V1Plugin;
};
// END_BLOCK_DUAL_PLUGIN_TYPE

// START_BLOCK_DEFINE_DUAL_PLUGIN
/**
 * Build the dual entrypoint for one plugin.
 *
 * The v1 factory keeps its original single-argument or two-argument signature
 * and is wrapped verbatim as the server() member. The v2 setup receives the v2
 * plugin context and may return nothing yet; later migration tasks attach the
 * domain registrations.
 */
export function defineDualPlugin(definition: {
  id: string;
  v1: V1Plugin;
  v2: V2Setup;
}): DualPlugin {
  return {
    ...V2Plugin.define({
      id: definition.id,
      setup: definition.v2,
    }),
    server: definition.v1,
  };
}
// END_BLOCK_DEFINE_DUAL_PLUGIN

// START_BLOCK_MERGE_V1_HOOKS
/**
 * Merge multiple v1 hook objects into one hook object.
 *
 * The v1 runtime triggers each hook key across plugin entries sequentially in
 * registration order, and calls dispose() on every entry in registration order
 * at shutdown. Producing one merged object that chains every key sequentially
 * and forwards dispose in registration order reproduces that behavior exactly
 * while presenting the aggregator as a single plugin entry.
 *
 * Children that returned undefined or an object without the requested key are
 * skipped for that key. An empty list produces an object with no hook members.
 */
export function mergeV1Hooks(entries: Array<Hooks | undefined>): Hooks {
  const present = entries.filter((entry): entry is Hooks => Boolean(entry));
  const keys = new Set<string>();
  for (const entry of present) {
    for (const key of Object.keys(entry)) {
      keys.add(key);
    }
  }

  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    if (key === "dispose") continue;
    const handlers = present
      .map((entry) => (entry as Record<string, unknown>)[key])
      .filter((handler): handler is NonNullable<typeof handler> => typeof handler === "function");
    if (handlers.length === 0) continue;
    merged[key] = async (input: unknown, output: unknown) => {
      for (const handler of handlers) {
        await (handler as (input: unknown, output: unknown) => Promise<void>)(input, output);
      }
    };
  }

  const disposers = present
    .map((entry) => entry.dispose)
    .filter((disposer): disposer is NonNullable<typeof disposer> => typeof disposer === "function");
  if (disposers.length > 0) {
    merged.dispose = async () => {
      for (const disposer of disposers) {
        await disposer();
      }
    };
  }

  return merged as Hooks;
}
// END_BLOCK_MERGE_V1_HOOKS

// START_BLOCK_AGGREGATE_V1_PLUGINS
/**
 * Run v1 plugin factories sequentially and merge their hook objects.
 *
 * A factory that throws is logged and skipped so one failing plugin cannot take
 * the remaining plugins offline, matching how the v1 runtime isolates plugin
 * load failures across separate package entries.
 */
export async function aggregateV1Plugins(
  factories: Array<V1Plugin>,
  input: PluginInput,
  options?: PluginOptions,
  onError?: (error: unknown, index: number) => void,
): Promise<Hooks> {
  const results: Array<Hooks | undefined> = [];
  for (const [index, factory] of factories.entries()) {
    try {
      results.push(await factory(input, options));
    } catch (error) {
      onError?.(error, index);
    }
  }
  return mergeV1Hooks(results);
}
// END_BLOCK_AGGREGATE_V1_PLUGINS
