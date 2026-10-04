// FILE: src/plugins/telegram/config.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Resolve the optional canonical telegram section into the runtime gateway configuration the Telegram bridge consumes.
//   SCOPE: Disabled-cause discrimination with value-free diagnostics, ${VAR} botToken resolution through the shared env-substitution helper with unset-reference reporting by name only, activity-window and delivery-setting defaults, connectivity passthrough, and a stable credential-safe bot fingerprint for storage reset decisions.
//   DEPENDS: [node:crypto, src/lib/env-substitution.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-TELEGRAM-CONFIG, M-ENV-SUBSTITUTION, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   DEFAULT_TELEGRAM_ACTIVITY_WINDOW_MINUTES - Default minutes a session stays active after its last update.
//   DEFAULT_TELEGRAM_SETTINGS - Default owner-tunable delivery settings (hidden reasoning, visible compact tool lines, markdown).
//   TelegramRuntimeSettings - Fully defaulted delivery settings consumed by the delivery layer.
//   TelegramDisabledReason - Why the gateway is disabled (absent, disabled, empty or unresolved token).
//   ResolvedTelegramConfig - Enabled gateway configuration or a disabled result with a value-free reason.
//   resolveTelegramConfig - Resolve an optional telegram section plus environment into the gateway configuration.
//   telegramBotFingerprint - Stable credential-safe fingerprint of a bot token for storage reset decisions.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-BRIDGE-PLUGIN T-001 - Created the telegram config resolver with env-placeholder token resolution, disabled-cause diagnostics, defaults, and the bot fingerprint helper.]
// END_CHANGE_SUMMARY

import { createHash } from "node:crypto";
import { resolveEnvPlaceholders } from "../../lib/env-substitution.js";
import type { VvocTelegramConfig } from "../../lib/vvoc-config.js";

/** Default minutes a session stays active after its last update before its topic closes. */
export const DEFAULT_TELEGRAM_ACTIVITY_WINDOW_MINUTES = 240;

/** Default owner-tunable delivery settings: reasoning hidden, tool detail compact, markdown replies. */
export const DEFAULT_TELEGRAM_SETTINGS = {
  showReasoning: false,
  showToolCalls: true,
  formatMode: "markdown",
  codeFileMaxKb: 100,
  mergeWindowMs: 1_500,
} as const;

/** Fully defaulted delivery settings consumed by the delivery layer. */
export type TelegramRuntimeSettings = {
  readonly showReasoning: boolean;
  readonly showToolCalls: boolean;
  readonly formatMode: "markdown" | "raw";
  readonly codeFileMaxKb: number;
  readonly mergeWindowMs: number;
};

/** Why the gateway stays disabled; never carries token material. */
export type TelegramDisabledReason =
  | "section-absent"
  | "disabled"
  | "token-empty"
  | "token-unresolved";

/** Enabled gateway configuration, or a disabled result with a value-free reason. */
export type ResolvedTelegramConfig =
  | {
      readonly enabled: false;
      readonly reason: TelegramDisabledReason;
      /** Referenced ${VAR} names that resolved to nothing, in first-reference order; never values. */
      readonly missingVars: readonly string[];
    }
  | {
      readonly enabled: true;
      readonly botToken: string;
      readonly allowedUserIds: readonly number[];
      readonly activityWindowMinutes: number;
      readonly apiRoot: string | undefined;
      readonly proxyUrl: string | undefined;
      readonly settings: TelegramRuntimeSettings;
    };

// START_CONTRACT: resolveTelegramConfig
//   PURPOSE: Resolve an optional validated telegram section plus the process environment into the gateway configuration.
//   INPUTS: { section: VvocTelegramConfig | undefined - canonical telegram section; env: NodeJS.ProcessEnv - environment for ${VAR} token resolution }
//   OUTPUTS: { ResolvedTelegramConfig - enabled configuration with defaults applied, or a disabled result with a value-free reason }
//   SIDE_EFFECTS: none; the token value never leaves the returned object and diagnostics carry variable names only
//   LINKS: M-ENV-SUBSTITUTION, M-TELEGRAM-GATEWAY
// END_CONTRACT: resolveTelegramConfig
export function resolveTelegramConfig(
  section: VvocTelegramConfig | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedTelegramConfig {
  if (section === undefined) {
    return { enabled: false, reason: "section-absent", missingVars: [] };
  }
  if (section.enabled === false) {
    return { enabled: false, reason: "disabled", missingVars: [] };
  }

  const resolution = resolveEnvPlaceholders(section.botToken, env);
  if (resolution.missing.length > 0) {
    return { enabled: false, reason: "token-unresolved", missingVars: resolution.missing };
  }
  const botToken = resolution.value.trim();
  if (botToken.length === 0) {
    return { enabled: false, reason: "token-empty", missingVars: [] };
  }

  const settings = section.settings ?? {};
  return {
    enabled: true,
    botToken,
    allowedUserIds: [...section.allowedUserIds],
    activityWindowMinutes:
      section.activityWindowMinutes ?? DEFAULT_TELEGRAM_ACTIVITY_WINDOW_MINUTES,
    apiRoot: section.apiRoot,
    proxyUrl: section.proxyUrl,
    settings: {
      showReasoning: settings.showReasoning ?? DEFAULT_TELEGRAM_SETTINGS.showReasoning,
      showToolCalls: settings.showToolCalls ?? DEFAULT_TELEGRAM_SETTINGS.showToolCalls,
      formatMode: settings.formatMode ?? DEFAULT_TELEGRAM_SETTINGS.formatMode,
      codeFileMaxKb: settings.codeFileMaxKb ?? DEFAULT_TELEGRAM_SETTINGS.codeFileMaxKb,
      mergeWindowMs: settings.mergeWindowMs ?? DEFAULT_TELEGRAM_SETTINGS.mergeWindowMs,
    },
  };
}

// START_CONTRACT: telegramBotFingerprint
//   PURPOSE: Derive a stable credential-safe fingerprint of a bot token for storage reset decisions.
//   INPUTS: { token: string - resolved bot token }
//   OUTPUTS: { string - hex digest of the token; never reversible to the token through logs alone }
//   SIDE_EFFECTS: none
//   LINKS: M-TELEGRAM-TOPICS
// END_CONTRACT: telegramBotFingerprint
export function telegramBotFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}
