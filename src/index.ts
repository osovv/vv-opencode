// FILE: src/index.ts
// VERSION: 0.2.5
// START_MODULE_CONTRACT
//   PURPOSE: Re-export the public vv-opencode plugin entrypoints from the package root.
//   SCOPE: Package-root exports for GuardianPlugin and MemoryPlugin.
//   DEPENDS: [src/plugins/guardian.ts, src/plugins/memory.ts]
//   LINKS: [M-PLUGIN-GUARDIAN, M-PLUGIN-MEMORY]
//   ROLE: BARREL
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   GuardianPlugin, MemoryPlugin - Public plugin exports available from @osovv/vv-opencode.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.5 - Added GRACE barrel markup so package-root exports can be navigated deterministically.]
// END_CHANGE_SUMMARY

export { GuardianPlugin } from "./plugins/guardian.js";
export { MemoryPlugin } from "./plugins/memory.js";
