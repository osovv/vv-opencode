// FILE: src/plugins/telegram/log.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Append token-free Telegram bridge diagnostics to a bounded log file under the vvoc data dir and read its tail for the CLI.
//   SCOPE: Path resolution with an injectable data dir, timestamped append, single-sibling size rotation, and a bounded tail reader; every failure is swallowed so diagnostics never break the gateway.
//   DEPENDS: [node:fs, node:path, src/lib/vvoc-paths.ts]
//   LINKS: [M-PLUGIN-TELEGRAM-BRIDGE, M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   TELEGRAM_LOG_MAX_BYTES - Size cap in bytes before the log rotates to its .1 sibling.
//   getTelegramLogPath - Resolve the plugin log file path under the vvoc data dir.
//   createTelegramFileLog - Build a plugin log sink that appends timestamped lines to the bounded file.
//   readTelegramLogTail - Read up to N trailing lines from the plugin log file.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-TOPIC-HYGIENE T-006 - Added the bounded Telegram plugin file log and its tail reader.]
// END_CHANGE_SUMMARY

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getGlobalVvocDataDir } from "../../lib/vvoc-paths.js";

/** Size cap in bytes before the log rotates to its .1 sibling. */
export const TELEGRAM_LOG_MAX_BYTES = 1_000_000;

/** Resolve the plugin log file path under the vvoc data dir. */
export function getTelegramLogPath(dataHomeOverride?: string): string {
  return join(getGlobalVvocDataDir(dataHomeOverride), "telegram", "telegram.log");
}

// START_CONTRACT: createTelegramFileLog
//   PURPOSE: Build a plugin log sink that appends timestamped lines to a size-bounded file.
//   INPUTS: { options: { path?, maxBytes?, now? } - injectable path, cap, and clock for tests }
//   OUTPUTS: { (level, message) => void - sink the plugin assembly uses as its default log }
//   SIDE_EFFECTS: creates the parent directory, appends to the log file, and rotates it to .1 past the cap
//   LINKS: M-PLUGIN-TELEGRAM-BRIDGE
// END_CONTRACT: createTelegramFileLog
export function createTelegramFileLog(
  options: { path?: string; maxBytes?: number; now?: () => Date } = {},
): (level: "info" | "warn", message: string) => void {
  const path = options.path ?? getTelegramLogPath();
  const maxBytes = options.maxBytes ?? TELEGRAM_LOG_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  return (level, message) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path) && statSync(path).size >= maxBytes) {
        renameSync(path, `${path}.1`);
      }
      appendFileSync(path, `${now().toISOString()} [${level}] ${message}\n`);
    } catch {
      // Diagnostics are best-effort and never break the gateway.
    }
  };
}

/** Read up to N trailing lines from the plugin log file; an absent or unreadable file yields none. */
export function readTelegramLogTail(
  lines = 50,
  options: { path?: string } = {},
): readonly string[] {
  const path = options.path ?? getTelegramLogPath();
  try {
    if (!existsSync(path)) return [];
    const content = readFileSync(path, "utf8");
    const all = content.split("\n").filter((line) => line.length > 0);
    const limit = Math.max(1, Math.trunc(lines));
    return all.slice(Math.max(0, all.length - limit));
  } catch {
    return [];
  }
}
