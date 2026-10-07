// FILE: src/commands/telegram-status.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the vvoc telegram status report: enabled and disabled causes, token probe, durable state, restart heuristic, and token-safe rendering.
//   SCOPE: Injected config, probe, state, and mtime seams driving collectTelegramStatus and renderTelegramStatus; no network, database, or real token.
//   DEPENDS: [src/commands/telegram-status.ts]
//   LINKS: [M-CLI-COMMANDS, V-M-CLI-COMMANDS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   durableState - Minimal durable state fixture per test.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-TOPIC-HYGIENE T-008 - Covered enabled, disabled, restart, and token-safe status rendering.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { collectTelegramStatus, renderTelegramStatus } from "./telegram-status.js";
import type { TelegramDurableState } from "./telegram-status.js";

function durableState(overrides: Partial<TelegramDurableState> = {}): TelegramDurableState {
  const now = Date.now();
  return {
    metaFound: true,
    generalThreadId: 42,
    fingerprint: undefined,
    topics: 3,
    sessions: 3,
    mirrors: 9,
    offset: 100,
    offsetUpdatedAtMs: now,
    lastActivityMs: now,
    ...overrides,
  };
}

describe("collectTelegramStatus", () => {
  test("reports enabled config with a live token and durable state", async () => {
    const report = await collectTelegramStatus({
      env: { TELEGRAM_BOT_TOKEN: "123:abc" },
      loadConfig: async () => ({
        plugins: { telegram: true },
        telegram: { botToken: "${TELEGRAM_BOT_TOKEN}", allowedUserIds: [1] },
      }),
      probeToken: async () => ({ ok: true, username: "demo_bot" }),
      readState: async () => durableState(),
      configMtimeMs: 1,
      logMtimeMs: 2,
    });
    expect(report.enabled).toBe(true);
    expect(report.tokenOk).toBe(true);
    expect(report.botUsername).toBe("demo_bot");
    expect(report.state.topics).toBe(3);
    expect(report.verdict).toBe("healthy");
  });

  test("reports a token-unresolved reason with variable names only", async () => {
    const report = await collectTelegramStatus({
      env: {},
      loadConfig: async () => ({
        plugins: { telegram: true },
        telegram: { botToken: "${MISSING_TELEGRAM_TOKEN}", allowedUserIds: [1] },
      }),
      readState: async () => durableState(),
    });
    expect(report.enabled).toBe(false);
    expect(report.reason).toBe("token-unresolved");
    expect(report.missingVars).toEqual(["MISSING_TELEGRAM_TOKEN"]);
    expect(report.verdict).toContain("token-unresolved");
  });

  test("reports the disabled plugin toggle", async () => {
    const report = await collectTelegramStatus({
      loadConfig: async () => ({
        plugins: { telegram: false },
        telegram: { botToken: "123:abc", allowedUserIds: [1] },
      }),
      readState: async () => durableState(),
    });
    expect(report.enabled).toBe(false);
    expect(report.reason).toBe("toggle-disabled");
  });

  test("flags a config newer than the last gateway boot", async () => {
    const report = await collectTelegramStatus({
      env: { T: "123:abc" },
      loadConfig: async () => ({
        plugins: {},
        telegram: { botToken: "${T}", allowedUserIds: [1] },
      }),
      probeToken: async () => ({ ok: true, username: "b" }),
      readState: async () => durableState(),
      configMtimeMs: 5,
      logMtimeMs: 4,
    });
    expect(report.restartLikely).toBe(true);
    expect(report.verdict).toContain("restart");
  });

  test("renders without ever printing the token", async () => {
    const report = await collectTelegramStatus({
      env: { T: "123:secret-token" },
      loadConfig: async () => ({
        plugins: {},
        telegram: { botToken: "${T}", allowedUserIds: [1] },
      }),
      probeToken: async () => ({ ok: true, username: "b" }),
      readState: async () => durableState(),
      configMtimeMs: 1,
      logMtimeMs: 2,
    });
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      renderTelegramStatus(report);
    } finally {
      console.log = original;
    }
    expect(lines.join("\n")).not.toContain("123:secret-token");
    expect(lines.join("\n")).toContain("verdict");
  });
});
