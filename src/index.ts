// FILE: src/index.ts
// VERSION: 0.6.0
// START_MODULE_CONTRACT
//   PURPOSE: Re-export the public vv-opencode plugin entrypoints from the package root.
//   SCOPE: Package-root exports for GuardianPlugin, MemoryPlugin, ModelRolesPlugin, SystemContextInjectionPlugin, and SecretsRedactionPlugin.
//   DEPENDS: [src/plugins/guardian/index.ts, src/plugins/memory/index.ts, src/plugins/model-roles/index.ts, src/plugins/system-context-injection/index.ts, src/plugins/secrets-redaction.ts]
//   LINKS: [M-PLUGIN-GUARDIAN, M-PLUGIN-MEMORY, M-PLUGIN-MODEL-ROLES, M-PLUGIN-SYSTEM-CONTEXT-INJECTION, M-PLUGIN-SECRETS-REDACTION]
//   ROLE: BARREL
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   GuardianPlugin, MemoryPlugin, ModelRolesPlugin, SystemContextInjectionPlugin, SecretsRedactionPlugin - Public plugin exports available from @osovv/vv-opencode.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.6.0 - Added ModelRolesPlugin to the package-root plugin exports.]
// END_CHANGE_SUMMARY

export { GuardianPlugin } from "./plugins/guardian/index.js";
export { MemoryPlugin } from "./plugins/memory/index.js";
export { ModelRolesPlugin } from "./plugins/model-roles/index.js";
export { SystemContextInjectionPlugin } from "./plugins/system-context-injection/index.js";
export { SecretsRedactionPlugin } from "./plugins/secrets-redaction.js";
