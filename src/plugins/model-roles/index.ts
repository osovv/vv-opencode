// FILE: src/plugins/model-roles/index.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Native ModelRolesPlugin that delegates to the shared native snapshot runtime, enabling vvoc role overriding when the model-roles toggle is on.
//   SCOPE: Native Plugin.define default export, plugin-toggle check, shared runtime acquisition, role-override enablement, and scoped release. Core policy capture, admission, guarding, title auxiliary work and native config watching live in the shared runtime, so this toggle never disables other plugins' policy capture or guards. No V1 fake client, no singleton startup config, no forced location reload, no stateless generation, and no cosmetic compatibility cast.
//   DEPENDS: [@opencode/plugin, src/lib/config-layers.ts, src/lib/plugin-toggle-config.ts, src/runtime/context.ts]
//   LINKS: [M-PLUGIN-MODEL-ROLES, M-NATIVE-RUNTIME, V-M-PLUGIN-MODEL-ROLES]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ModelRolesRegistration - Releasable plugin-owned registration.
//   registerModelRoles - Enable or disable vvoc role overriding on the shared native snapshot runtime.
//   ModelRolesPlugin - Native Plugin.define object for vvoc model-roles.
//   default - Default export: the native ModelRolesPlugin object.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-002 - Delegated to acquireNativeSnapshotRuntime so the toggle only controls role overriding.]
// END_CHANGE_SUMMARY

import { Plugin } from "@opencode/plugin";
import { loadEffectiveVvocConfig } from "../../lib/config-layers.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import {
  acquireNativeSnapshotRuntime,
  type NativeForkClient,
  type NativeSnapshotContext,
  type NativeSnapshotRuntimeOptions,
} from "../../runtime/context.js";
import type { OpenCodeClient } from "@opencode/client";

/** Releasable plugin-owned registration. */
export interface ModelRolesRegistration {
  dispose(): Promise<void> | void;
}

/**
 * Enable or disable vvoc role overriding on the shared native snapshot runtime.
 * Policy capture, admission, guarding and auxiliary work stay active regardless,
 * so another plugin sharing the same context keeps its stable policy service.
 */
export async function registerModelRoles<Client extends NativeForkClient = OpenCodeClient>(
  ctx: NativeSnapshotContext,
  options: { readonly enabled: boolean } & NativeSnapshotRuntimeOptions<Client>,
): Promise<ModelRolesRegistration> {
  const runtime = await acquireNativeSnapshotRuntime(ctx, {
    ...(options.runtimeDeps === undefined ? {} : { runtimeDeps: options.runtimeDeps }),
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  await runtime.setRoleOverride(options.enabled);
  let released = false;
  return {
    async dispose() {
      if (released) return;
      released = true;
      await runtime.release();
    },
  };
}

// START_BLOCK_PLUGIN_ENTRY
/** Native model-roles plugin: applies vvoc role overrides through the shared snapshot runtime. */
export const ModelRolesPlugin = Plugin.define({
  id: "vvoc.model-roles",
  setup: async (ctx) => {
    const config = await loadEffectiveVvocConfig({ cwd: ctx.location.directory });
    const enabled = isVvocPluginEnabled(config.config, "model-roles");
    // `Plugin.Context` structurally satisfies the narrow snapshot context; the runtime
    // is keyed by this exact context object so later plugins share one instance.
    const registration = await registerModelRoles(ctx, { enabled });
    return () => registration.dispose();
  },
});

export default ModelRolesPlugin;
// END_BLOCK_PLUGIN_ENTRY
