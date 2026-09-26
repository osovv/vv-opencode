// FILE: src/index.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Publish the dual-runtime vv-opencode package entrypoint that loads under OpenCode v1 (>= 1.18.29 via server()) and OpenCode v2 (>= 2.0.18 via setup()).
//   SCOPE: Package-root default export aggregating the eleven vvoc server plugins for the v1 runtime and delegating to the v2 runtime adapter for the v2 runtime; no named plugin exports remain at the root so neither runtime can double-register.
//   DEPENDS: [src/plugins/v2-runtime/index.ts, src/plugins/guardian/index.ts, src/plugins/hashline-edit/index.ts, src/plugins/model-roles/index.ts, src/plugins/system-context-injection/index.ts, src/plugins/workflow/index.ts, src/plugins/secrets-redaction/index.ts, src/plugins/web-tools/index.ts, src/plugins/tool-history-compaction/index.ts, src/plugins/analytics/index.ts, src/plugins/peak-hours/index.ts, src/plugins/spec-guard/index.ts]
//   LINKS: [M-PLUGIN-V2-RUNTIME, M-PLUGIN-GUARDIAN, M-PLUGIN-HASHLINE-EDIT, M-PLUGIN-MODEL-ROLES, M-PLUGIN-SYSTEM-CONTEXT-INJECTION, M-PLUGIN-WORKFLOW, M-PLUGIN-SECRETS-REDACTION, M-PLUGIN-WEB-TOOLS, M-PLUGIN-TOOL-HISTORY-COMPACTION, M-PLUGIN-ANALYTICS, M-PLUGIN-PEAK-HOURS, M-PLUGIN-SPEC-GUARD]
//   ROLE: RUNTIME
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Dual-runtime vvoc plugin entrypoint: v2 setup() through the v2 runtime adapter, v1 server() aggregating all server plugins.
//   V1_PLUGIN_ORDER - Registration order of the v1 plugin factories, preserving the pre-migration named-export load order.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION - Replaced the eleven named root plugin exports with one dual-runtime default export; per-plugin factories remain available through their ./plugins/* subpath dual entrypoints.]
// END_CHANGE_SUMMARY

import { aggregateV1Plugins, defineDualPlugin } from "./plugins/v2-runtime/index.js";
import { GuardianPlugin } from "./plugins/guardian/index.js";
import { HashlineEditPlugin } from "./plugins/hashline-edit/index.js";
import { ModelRolesPlugin } from "./plugins/model-roles/index.js";
import { SystemContextInjectionPlugin } from "./plugins/system-context-injection/index.js";
import { WorkflowPlugin } from "./plugins/workflow/index.js";
import { SecretsRedactionPlugin } from "./plugins/secrets-redaction/index.js";
import { WebToolsPlugin } from "./plugins/web-tools/index.js";
import { ToolHistoryCompactionPlugin } from "./plugins/tool-history-compaction/index.js";
import { AnalyticsPlugin } from "./plugins/analytics/index.js";
import { PeakHoursPlugin } from "./plugins/peak-hours/index.js";
import { SpecGuardPlugin } from "./plugins/spec-guard/index.js";
import { setupV2Plugins } from "./plugins/v2-runtime/setup.js";

// START_BLOCK_V1_PLUGIN_ORDER
/**
 * v1 plugin factories in the historical named-export load order from the
 * pre-migration root module, so hook trigger order stays deterministic.
 */
export const V1_PLUGIN_ORDER = [
  GuardianPlugin,
  HashlineEditPlugin,
  ModelRolesPlugin,
  SystemContextInjectionPlugin,
  WorkflowPlugin,
  SecretsRedactionPlugin,
  WebToolsPlugin,
  ToolHistoryCompactionPlugin,
  AnalyticsPlugin,
  PeakHoursPlugin,
  SpecGuardPlugin,
];
// END_BLOCK_V1_PLUGIN_ORDER

// START_BLOCK_DUAL_ROOT_ENTRY
export default defineDualPlugin({
  id: "vvoc",
  async v1(input, options) {
    return aggregateV1Plugins(V1_PLUGIN_ORDER, input, options, (error, index) => {
      console.error(
        `[vvoc][v1-runtime] plugin ${V1_PLUGIN_ORDER[index]?.name ?? `#${index}`} failed to load: ${String(error)}`,
      );
    });
  },
  v2: setupV2Plugins,
});
// END_BLOCK_DUAL_ROOT_ENTRY
