// FILE: src/index.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Re-export the public vv-opencode plugin entrypoints from the package root.
//   SCOPE: Package-root exports for GuardianPlugin, MemoryPlugin, and SecretsRedactionPlugin.
//   DEPENDS: [src/plugins/guardian.ts, src/plugins/memory.ts, src/plugins/secrets-redaction.ts]
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
//   LAST_CHANGE: [v0.3.0 - Added SecretsRedactionPlugin for secret redaction in LLM requests.]
// END_CHANGE_SUMMARY

export { GuardianPlugin } from "./plugins/guardian.js";
export { MemoryPlugin } from "./plugins/memory.js";
export { SecretsRedactionPlugin } from "./plugins/secrets-redaction.js";
