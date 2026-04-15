// FILE: src/commands/agent.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Keep a legacy vvoc agent command shim for backwards compatibility messaging.
//   SCOPE: Emit a clear migration error directing users to vvoc role.
//   DEPENDS: [citty]
//   LINKS: [M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Legacy command shim for vvoc agent.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Retired vvoc agent behavior and replaced it with a migration message to vvoc role.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
export default defineCommand({
  meta: {
    name: "agent",
    description: "Legacy alias removed in favor of vvoc role.",
  },
  async run() {
    throw new Error("`vvoc agent` has been removed. Use `vvoc role` instead.");
  },
});
