// FILE: src/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Re-export the public vv-opencode plugin entrypoints from the package root.
//   SCOPE: Package-root exports for GuardianPlugin, HashlineEditPlugin, ModelRolesPlugin, SystemContextInjectionPlugin, WorkflowPlugin, SecretsRedactionPlugin, WebToolsPlugin, ToolHistoryCompactionPlugin, AnalyticsPlugin, PeakHoursPlugin, and SpecGuardPlugin.
//   DEPENDS: [src/plugins/guardian/index.ts, src/plugins/hashline-edit/index.ts, src/plugins/model-roles/index.ts, src/plugins/system-context-injection/index.ts, src/plugins/workflow/index.ts, src/plugins/secrets-redaction.ts, src/plugins/web-tools/index.ts, src/plugins/tool-history-compaction/index.ts, src/plugins/analytics/index.ts, src/plugins/peak-hours/index.ts, src/plugins/spec-guard/index.ts]
//   LINKS: [M-PLUGIN-GUARDIAN, M-PLUGIN-HASHLINE-EDIT, M-PLUGIN-MODEL-ROLES, M-PLUGIN-SYSTEM-CONTEXT-INJECTION, M-PLUGIN-WORKFLOW, M-PLUGIN-SECRETS-REDACTION, M-PLUGIN-WEB-TOOLS, M-PLUGIN-TOOL-HISTORY-COMPACTION, M-PLUGIN-ANALYTICS, M-PLUGIN-PEAK-HOURS, M-PLUGIN-SPEC-GUARD]
//   ROLE: BARREL
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   GuardianPlugin, HashlineEditPlugin, ModelRolesPlugin, SystemContextInjectionPlugin, WorkflowPlugin, SecretsRedactionPlugin, WebToolsPlugin, ToolHistoryCompactionPlugin, AnalyticsPlugin, PeakHoursPlugin, SpecGuardPlugin - Public plugin exports available from @osovv/vv-opencode.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SPEC-IDENTITY-LINT - Added SpecGuardPlugin to the package-root exports.]
// END_CHANGE_SUMMARY

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
