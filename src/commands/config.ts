// FILE: src/commands/config.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Group config-related subcommands (validate) under the vvoc config parent command.
//   SCOPE: Parent command definition and subcommand wiring.
//   DEPENDS: [citty, src/commands/config-validate.js]
//   LINKS: [M-CLI-CONFIG-VALIDATE, M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Config parent command grouping config subcommands.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.0 - Initial GRACE implementation for config parent command.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import validateCommand from "./config-validate.js";

export default defineCommand({
  meta: {
    name: "config",
    description: "Config-related commands.",
  },
  subCommands: {
    validate: validateCommand,
  },
});
