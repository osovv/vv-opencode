// FILE: src/commands/plugin.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Group plugin-related subcommands (list) under the vvoc plugin parent command.
//   SCOPE: Parent command definition and subcommand wiring.
//   DEPENDS: [citty, src/commands/plugin-list.js]
//   LINKS: [M-CLI-PLUGIN-LIST, M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Plugin parent command grouping plugin subcommands.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.0 - Initial GRACE implementation for plugin parent command.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import listCommand from "./plugin-list.js";

export default defineCommand({
  meta: {
    name: "plugin",
    description: "Plugin management commands.",
  },
  subCommands: {
    list: listCommand,
  },
});
