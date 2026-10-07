// FILE: src/commands/telegram-log.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Print the tail of the vvoc Telegram plugin log, or its file path.
//   SCOPE: Optional line-count parsing with a bounded default and a path-only flag over the bounded log reader.
//   DEPENDS: [citty, src/plugins/telegram/log.ts]
//   LINKS: [M-CLI-COMMANDS, M-PLUGIN-TELEGRAM-BRIDGE]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - The vvoc telegram log command definition.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-TOPIC-HYGIENE T-008 - Added the vvoc telegram log command over the bounded plugin log.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { getTelegramLogPath, readTelegramLogTail } from "../plugins/telegram/log.js";

export default defineCommand({
  meta: {
    name: "log",
    description: "Print the tail of the vvoc Telegram plugin log.",
  },
  args: {
    lines: {
      type: "string",
      description: "Number of trailing lines to print (default 50).",
    },
    path: {
      type: "boolean",
      default: false,
      description: "Print only the log file path.",
    },
  },
  run({ args }) {
    if (args.path === true) {
      console.log(getTelegramLogPath());
      return;
    }
    const parsed = typeof args.lines === "string" ? Number.parseInt(args.lines, 10) : Number.NaN;
    const lines = Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
    const tail = readTelegramLogTail(lines);
    if (tail.length === 0) {
      console.log(`(no log yet at ${getTelegramLogPath()})`);
      return;
    }
    for (const line of tail) {
      console.log(line);
    }
  },
});
