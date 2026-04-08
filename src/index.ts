// FILE: src/index.ts
// VERSION: 0.3.1
// START_MODULE_CONTRACT
//   PURPOSE: Re-export the public vv-opencode plugin entrypoints from the package root.
//   SCOPE: Package-root exports for GuardianPlugin, MemoryPlugin, EnhanceCommandPlugin, and SecretsRedactionPlugin.
//   DEPENDS: [src/plugins/guardian/index.ts, src/plugins/memory/index.ts, src/plugins/enhance/index.ts, src/plugins/secrets-redaction.ts]
//   LINKS: [M-PLUGIN-GUARDIAN, M-PLUGIN-MEMORY, M-PLUGIN-ENHANCE, M-PLUGIN-SECRETS-REDACTION]
//   ROLE: BARREL
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   GuardianPlugin, MemoryPlugin, EnhanceCommandPlugin, SecretsRedactionPlugin - Public plugin exports available from @osovv/vv-opencode.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.3.1 - Added EnhanceCommandPlugin export for runtime /enhance prompt rewriting.]
// END_CHANGE_SUMMARY

export { GuardianPlugin } from "./plugins/guardian/index.js";
export { MemoryPlugin } from "./plugins/memory/index.js";
export { EnhanceCommandPlugin } from "./plugins/enhance/index.js";
export { SecretsRedactionPlugin } from "./plugins/secrets-redaction.js";
