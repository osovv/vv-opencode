// FILE: src/index.ts
// VERSION: 0.9.0
// START_MODULE_CONTRACT
//   PURPOSE: Re-export the public vv-opencode plugin entrypoints from the package root.
//   SCOPE: Package-root exports for GuardianPlugin, HashlineEditPlugin, ModelRolesPlugin, SystemContextInjectionPlugin, WorkflowPlugin, and SecretsRedactionPlugin.
//   DEPENDS: [src/plugins/guardian/index.ts, src/plugins/hashline-edit/index.ts, src/plugins/model-roles/index.ts, src/plugins/system-context-injection/index.ts, src/plugins/workflow/index.ts, src/plugins/secrets-redaction.ts]
//   LINKS: [M-PLUGIN-GUARDIAN, M-PLUGIN-HASHLINE-EDIT, M-PLUGIN-MODEL-ROLES, M-PLUGIN-SYSTEM-CONTEXT-INJECTION, M-PLUGIN-WORKFLOW, M-PLUGIN-SECRETS-REDACTION]
//   ROLE: BARREL
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   GuardianPlugin, HashlineEditPlugin, ModelRolesPlugin, SystemContextInjectionPlugin, WorkflowPlugin, SecretsRedactionPlugin - Public plugin exports available from @osovv/vv-opencode.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.9.0 - Removed MemoryPlugin, memory-store, and memory-reviewer. Memory is no longer a plugin.]
//   LAST_CHANGE: [v0.8.0 - Added WorkflowPlugin to the package-root plugin exports.]
//   LAST_CHANGE: [v0.7.0 - Added HashlineEditPlugin to the package-root plugin exports.]
//   LAST_CHANGE: [v0.6.0 - Added ModelRolesPlugin to the package-root plugin exports.]
// END_CHANGE_SUMMARY

export { GuardianPlugin } from "./plugins/guardian/index.js";
export { HashlineEditPlugin } from "./plugins/hashline-edit/index.js";
export { ModelRolesPlugin } from "./plugins/model-roles/index.js";
export { SystemContextInjectionPlugin } from "./plugins/system-context-injection/index.js";
export { WorkflowPlugin } from "./plugins/workflow/index.js";
export { SecretsRedactionPlugin } from "./plugins/secrets-redaction.js";
