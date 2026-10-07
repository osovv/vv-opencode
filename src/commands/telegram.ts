// FILE: src/commands/telegram.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Group Telegram bridge subcommands (status, log) under the vvoc telegram parent command.
//   SCOPE: Parent command definition and subcommand wiring.
//   DEPENDS: [citty, src/commands/telegram-status.js, src/commands/telegram-log.js]
//   LINKS: [M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Telegram parent command grouping bridge subcommands.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-TOPIC-HYGIENE T-008 - Created the telegram parent command for status and log.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import statusCommand from "./telegram-status.js";
import logCommand from "./telegram-log.js";

export default defineCommand({
  meta: {
    name: "telegram",
    description: "Telegram bridge commands.",
  },
  subCommands: {
    status: statusCommand,
    log: logCommand,
  },
});
