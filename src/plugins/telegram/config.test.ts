// FILE: src/plugins/telegram/config.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the telegram config resolver: disabled-cause discrimination, ${VAR} token resolution, defaults, and the credential-safe fingerprint.
//   SCOPE: Section-absent, disabled, empty, and unresolved causes with value-free missing-variable reporting, defaults for the activity window and delivery settings, connectivity passthrough, and fingerprint stability, all with an injected environment and no network or real tokens.
//   DEPENDS: [src/plugins/telegram/config.ts]
//   LINKS: [M-TELEGRAM-CONFIG, V-M-TELEGRAM-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   section - Minimal valid telegram section per test.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-BRIDGE-PLUGIN T-001 - Covered resolver causes, defaults, connectivity passthrough, and the fingerprint helper.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TELEGRAM_ACTIVITY_WINDOW_MINUTES,
  resolveTelegramConfig,
  telegramBotFingerprint,
} from "./config.js";
import type { VvocTelegramConfig } from "../../lib/vvoc-config.js";

function section(overrides: Partial<VvocTelegramConfig> = {}): VvocTelegramConfig {
  return {
    botToken: "${TELEGRAM_BOT_TOKEN}",
    allowedUserIds: [100_200_300],
    ...overrides,
  };
}

describe("resolveTelegramConfig disabled causes", () => {
  test("an absent section disables with section-absent", () => {
    const resolved = resolveTelegramConfig(undefined, {});
    expect(resolved).toEqual({ enabled: false, reason: "section-absent", missingVars: [] });
  });

  test("enabled false disables with disabled even when the token is present", () => {
    const resolved = resolveTelegramConfig(section({ enabled: false, botToken: "123:abc" }), {});
    expect(resolved).toEqual({ enabled: false, reason: "disabled", missingVars: [] });
  });

  test("an unset referenced variable disables with token-unresolved and names the variable without values", () => {
    const resolved = resolveTelegramConfig(section(), {});
    expect(resolved.enabled).toBe(false);
    if (!resolved.enabled) {
      expect(resolved.reason).toBe("token-unresolved");
      expect(resolved.missingVars).toEqual(["TELEGRAM_BOT_TOKEN"]);
    }
  });

  test("a variable resolving to an empty string disables with token-empty", () => {
    const resolved = resolveTelegramConfig(section(), { TELEGRAM_BOT_TOKEN: "  " });
    expect(resolved).toEqual({ enabled: false, reason: "token-empty", missingVars: [] });
  });
});

describe("resolveTelegramConfig enabled resolution", () => {
  test("resolves the token from the environment and applies every default", () => {
    const resolved = resolveTelegramConfig(section(), { TELEGRAM_BOT_TOKEN: "123:abc" });
    expect(resolved).toEqual({
      enabled: true,
      botToken: "123:abc",
      allowedUserIds: [100_200_300],
      activityWindowMinutes: DEFAULT_TELEGRAM_ACTIVITY_WINDOW_MINUTES,
      apiRoot: undefined,
      proxyUrl: undefined,
      settings: {
        showReasoning: false,
        showToolCalls: false,
        formatMode: "markdown",
        codeFileMaxKb: 100,
        mergeWindowMs: 1_500,
      },
    });
  });

  test("explicit activity window and settings win over defaults", () => {
    const resolved = resolveTelegramConfig(
      section({
        activityWindowMinutes: 30,
        settings: { showReasoning: true, formatMode: "raw", codeFileMaxKb: 5, mergeWindowMs: 0 },
      }),
      { TELEGRAM_BOT_TOKEN: "123:abc" },
    );
    expect(resolved.enabled).toBe(true);
    if (resolved.enabled) {
      expect(resolved.activityWindowMinutes).toBe(30);
      expect(resolved.settings.showReasoning).toBe(true);
      expect(resolved.settings.showToolCalls).toBe(false);
      expect(resolved.settings.formatMode).toBe("raw");
      expect(resolved.settings.codeFileMaxKb).toBe(5);
      expect(resolved.settings.mergeWindowMs).toBe(0);
    }
  });

  test("connectivity fields pass through untouched", () => {
    const resolved = resolveTelegramConfig(section({ apiRoot: "https://tg.example.com" }), {
      TELEGRAM_BOT_TOKEN: "123:abc",
    });
    expect(resolved.enabled).toBe(true);
    if (resolved.enabled) {
      expect(resolved.apiRoot).toBe("https://tg.example.com");
      expect(resolved.proxyUrl).toBeUndefined();
    }
  });
});

describe("telegramBotFingerprint", () => {
  test("is stable, short, and differs between tokens without exposing them", () => {
    const a = telegramBotFingerprint("123:abc");
    expect(a).toBe(telegramBotFingerprint("123:abc"));
    expect(a).toHaveLength(16);
    expect(a).not.toBe(telegramBotFingerprint("123:abd"));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});
