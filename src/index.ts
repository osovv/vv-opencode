// FILE: src/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Re-export the public vv-opencode plugin entrypoints from the package root.
//   SCOPE: Package-root exports for GuardianPlugin, HashlineEditPlugin, ModelRolesPlugin, SystemContextInjectionPlugin, WorkflowPlugin, SecretsRedactionPlugin, WebToolsPlugin, and ToolHistoryCompactionPlugin.
//   DEPENDS: [src/plugins/guardian/index.ts, src/plugins/hashline-edit/index.ts, src/plugins/model-roles/index.ts, src/plugins/system-context-injection/index.ts, src/plugins/workflow/index.ts, src/plugins/secrets-redaction.ts, src/plugins/web-tools/index.ts, src/plugins/tool-history-compaction/index.ts]
//   LINKS: [M-PLUGIN-GUARDIAN, M-PLUGIN-HASHLINE-EDIT, M-PLUGIN-MODEL-ROLES, M-PLUGIN-SYSTEM-CONTEXT-INJECTION, M-PLUGIN-WORKFLOW, M-PLUGIN-SECRETS-REDACTION, M-PLUGIN-WEB-TOOLS, M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: BARREL
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   GuardianPlugin, HashlineEditPlugin, ModelRolesPlugin, SystemContextInjectionPlugin, WorkflowPlugin, SecretsRedactionPlugin, WebToolsPlugin - Public plugin exports available from @osovv/vv-opencode.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.3.0 - Added ToolHistoryCompactionPlugin to the package-root exports.]
// END_CHANGE_SUMMARY

export { GuardianPlugin } from "./plugins/guardian/index.js";
export { HashlineEditPlugin } from "./plugins/hashline-edit/index.js";
export { ModelRolesPlugin } from "./plugins/model-roles/index.js";
export { SystemContextInjectionPlugin } from "./plugins/system-context-injection/index.js";
export { WorkflowPlugin } from "./plugins/workflow/index.js";
export { SecretsRedactionPlugin } from "./plugins/secrets-redaction.js";
export { WebToolsPlugin } from "./plugins/web-tools/index.js";
export { ToolHistoryCompactionPlugin } from "./plugins/tool-history-compaction/index.js";
