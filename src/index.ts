// FILE: src/index.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Re-export the public vv-opencode plugin entrypoints from the package root and assemble them into one native aggregate server plugin.
//   SCOPE: Package-root exports for GuardianPlugin, HashlineEditPlugin, ModelRolesPlugin, SystemContextInjectionPlugin, WorkflowPlugin, SecretsRedactionPlugin, WebToolsPlugin, ToolHistoryCompactionPlugin, AnalyticsPlugin, PeakHoursPlugin, and SpecGuardPlugin, plus the native default definition that sets all eleven up against one shared Context with complete reverse-order teardown and partial-setup rollback.
//   DEPENDS: [@opencode/plugin, src/plugins/guardian/index.ts, src/plugins/hashline-edit/index.ts, src/plugins/model-roles/index.ts, src/plugins/system-context-injection/index.ts, src/plugins/workflow/index.ts, src/plugins/secrets-redaction.ts, src/plugins/web-tools/index.ts, src/plugins/tool-history-compaction/index.ts, src/plugins/analytics/index.ts, src/plugins/peak-hours/index.ts, src/plugins/spec-guard/index.ts]
//   LINKS: [M-PLUGIN-GUARDIAN, M-PLUGIN-HASHLINE-EDIT, M-PLUGIN-MODEL-ROLES, M-PLUGIN-SYSTEM-CONTEXT-INJECTION, M-PLUGIN-WORKFLOW, M-PLUGIN-SECRETS-REDACTION, M-PLUGIN-WEB-TOOLS, M-PLUGIN-TOOL-HISTORY-COMPACTION, M-PLUGIN-ANALYTICS, M-PLUGIN-PEAK-HOURS, M-PLUGIN-SPEC-GUARD]
//   ROLE: BARREL
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   GuardianPlugin, HashlineEditPlugin, ModelRolesPlugin, SystemContextInjectionPlugin, WorkflowPlugin, SecretsRedactionPlugin, WebToolsPlugin, ToolHistoryCompactionPlugin, AnalyticsPlugin, PeakHoursPlugin, SpecGuardPlugin - Public plugin exports available from @osovv/vv-opencode.
//   VVOC_SERVER_PLUGINS - The eleven native server plugins in deterministic setup order (model roles first so the shared snapshot runtime exists before consumers).
//   VvocPlugin - Native aggregate server plugin that sets up all eleven plugins on one Context and tears them down in reverse order.
//   default - Native default server plugin definition loaded by OpenCode from the package or a local directory.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009 - Added the native aggregate default that sets up all eleven plugins on one shared Context with reverse-order teardown and partial-setup rollback.]
//   PREVIOUS: [C-SPEC-IDENTITY-LINT - Added SpecGuardPlugin to the package-root exports.]
// END_CHANGE_SUMMARY

import { Plugin } from "@opencode/plugin";
import { AnalyticsPlugin } from "./plugins/analytics/index.js";
import { GuardianPlugin } from "./plugins/guardian/index.js";
import { HashlineEditPlugin } from "./plugins/hashline-edit/index.js";
import { ModelRolesPlugin } from "./plugins/model-roles/index.js";
import { PeakHoursPlugin } from "./plugins/peak-hours/index.js";
import { SecretsRedactionPlugin } from "./plugins/secrets-redaction.js";
import { SpecGuardPlugin } from "./plugins/spec-guard/index.js";
import { SystemContextInjectionPlugin } from "./plugins/system-context-injection/index.js";
import { ToolHistoryCompactionPlugin } from "./plugins/tool-history-compaction/index.js";
import { WebToolsPlugin } from "./plugins/web-tools/index.js";
import { WorkflowPlugin } from "./plugins/workflow/index.js";

export { GuardianPlugin } from "./plugins/guardian/index.js";
export { HashlineEditPlugin } from "./plugins/hashline-edit/index.js";
export { ModelRolesPlugin } from "./plugins/model-roles/index.js";
export { SystemContextInjectionPlugin } from "./plugins/system-context-injection/index.js";
export { WorkflowPlugin } from "./plugins/workflow/index.js";
export { SecretsRedactionPlugin } from "./plugins/secrets-redaction.js";
export { WebToolsPlugin } from "./plugins/web-tools/index.js";
export { ToolHistoryCompactionPlugin } from "./plugins/tool-history-compaction/index.js";
export { AnalyticsPlugin } from "./plugins/analytics/index.js";
export { PeakHoursPlugin } from "./plugins/peak-hours/index.js";
export { SpecGuardPlugin } from "./plugins/spec-guard/index.js";

// START_BLOCK_AGGREGATE
/**
 * The eleven native server plugins in deterministic setup order. Model roles is
 * first so the shared snapshot runtime exists before every consumer acquires it;
 * every plugin still tolerates being set up standalone.
 */
export const VVOC_SERVER_PLUGINS: readonly Plugin.Plugin[] = [
  ModelRolesPlugin,
  SecretsRedactionPlugin,
  GuardianPlugin,
  HashlineEditPlugin,
  WebToolsPlugin,
  SystemContextInjectionPlugin,
  WorkflowPlugin,
  ToolHistoryCompactionPlugin,
  AnalyticsPlugin,
  PeakHoursPlugin,
  SpecGuardPlugin,
];

/**
 * Native aggregate server plugin. Every plugin is set up against the exact same
 * Context so the shared runtime is keyed once. A partial setup failure disposes
 * the already-registered cleanups in reverse order before rethrowing the original
 * error; a successful setup tears everything down in reverse order on cleanup.
 */
const VvocPlugin = Plugin.define({
  id: "vvoc",
  async setup(ctx) {
    const cleanups: Array<() => Promise<void> | void> = [];
    for (const plugin of VVOC_SERVER_PLUGINS) {
      try {
        const cleanup = await plugin.setup(ctx);
        if (typeof cleanup === "function") cleanups.push(cleanup);
      } catch (error) {
        for (const cleanup of cleanups.reverse()) {
          try {
            await cleanup();
          } catch {
            // Preserve the original setup failure; every cleanup is still attempted.
          }
        }
        throw error;
      }
    }
    return async () => {
      for (const cleanup of cleanups.reverse()) await cleanup();
    };
  },
});

export { VvocPlugin };
export default VvocPlugin;
// END_BLOCK_AGGREGATE
