// FILE: src/plugins/telegram/log.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the bounded Telegram plugin file log: timestamped append, size rotation, and tail reading.
//   SCOPE: A temporary log path with an injected clock proving append order, rotation to the .1 sibling past the cap, and the bounded tail slice; no writes outside the temp dir.
//   DEPENDS: [src/plugins/telegram/log.ts]
//   LINKS: [M-PLUGIN-TELEGRAM-BRIDGE, V-M-PLUGIN-TELEGRAM-BRIDGE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   withTempLog - Run a callback against a temporary log path and clean it up.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-TOPIC-HYGIENE T-006 - Covered append, size rotation, and tail reading for the plugin log.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelegramFileLog, readTelegramLogTail } from "./log.js";

function withTempLog(run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "vvoc-tg-log-"));
  try {
    run(join(dir, "telegram.log"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("telegram file log", () => {
  test("appends timestamped lines and reads the bounded tail", () => {
    withTempLog((path) => {
      const log = createTelegramFileLog({
        path,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      });
      log("info", "gateway started");
      log("warn", "poll error");
      expect(readTelegramLogTail(1, { path })).toEqual([
        "2026-01-01T00:00:00.000Z [warn] poll error",
      ]);
      expect(readTelegramLogTail(10, { path })).toHaveLength(2);
    });
  });

  test("rotates to the .1 sibling once the size cap is reached", () => {
    withTempLog((path) => {
      const log = createTelegramFileLog({ path, maxBytes: 10, now: () => new Date(0) });
      log("info", "first line longer than the cap");
      log("info", "second");
      expect(existsSync(`${path}.1`)).toBe(true);
      expect(readTelegramLogTail(5, { path })).toEqual(["1970-01-01T00:00:00.000Z [info] second"]);
    });
  });

  test("a missing log file yields an empty tail", () => {
    expect(readTelegramLogTail(5, { path: join(tmpdir(), "vvoc-missing-log-file.log") })).toEqual(
      [],
    );
  });
});
