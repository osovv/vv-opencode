// FILE: src/index.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Re-export the public vv-opencode plugin entrypoints from the package root.
//   SCOPE: Package-root exports for GuardianPlugin, MemoryPlugin, and SecretsRedactionPlugin.
//   DEPENDS: [src/plugins/guardian/index.ts, src/plugins/memory/index.ts, src/plugins/secrets-redaction.ts]
//   LINKS: [M-PLUGIN-GUARDIAN, M-PLUGIN-MEMORY, M-PLUGIN-SECRETS-REDACTION]
//   ROLE: BARREL
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   GuardianPlugin, MemoryPlugin, SecretsRedactionPlugin - Public plugin exports available from @osovv/vv-opencode.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.0 - Removed the legacy enhance runtime plugin export after dropping the old enhance command path.]
// END_CHANGE_SUMMARY

export { GuardianPlugin } from "./plugins/guardian/index.js";
export { MemoryPlugin } from "./plugins/memory/index.js";
export { SecretsRedactionPlugin } from "./plugins/secrets-redaction.js";
