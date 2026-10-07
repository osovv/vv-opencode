// FILE: src/commands/telegram-status.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Diagnose the vvoc Telegram bridge: resolved config and toggle, token liveness, bot fingerprint, durable topic and offset state, and a plain verdict.
//   SCOPE: Effective vvoc config loading with an injectable seam, value-free disabled-cause reporting, a bounded getMe probe, best-effort OpenCode kv state reading, restart-likelihood heuristics, and text or JSON rendering; the token is never printed.
//   DEPENDS: [citty, node:fs, bun:sqlite, src/lib/config-layers.ts, src/lib/plugin-toggle-config.ts, src/lib/vvoc-paths.ts, src/plugins/telegram/config.ts, src/plugins/telegram/log.ts]
//   LINKS: [M-CLI-COMMANDS, M-TELEGRAM-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   TelegramDurableState - Durable bridge state read from the OpenCode kv table.
//   TelegramStatusReport - Full status report rendered by the command.
//   TelegramStatusOptions - Injectable seams for the status report.
//   collectTelegramStatus - Build the report from injectable config, probe, and state seams.
//   renderTelegramStatus - Render a report as human-readable lines.
//   default - The vvoc telegram status command definition.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-TOPIC-HYGIENE T-008 - Added the vvoc telegram status command for cross-machine diagnosis.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadEffectiveVvocConfig } from "../lib/config-layers.js";
import { isVvocPluginEnabled } from "../lib/plugin-toggle-config.js";
import { getDataHome, getGlobalVvocConfigPath } from "../lib/vvoc-paths.js";
import { resolveTelegramConfig, telegramBotFingerprint } from "../plugins/telegram/config.js";
import { getTelegramLogPath } from "../plugins/telegram/log.js";
import type { VvocTelegramConfig } from "../lib/vvoc-config.js";

/** Durable bridge state read from the OpenCode kv table. */
export type TelegramDurableState = {
  readonly metaFound: boolean;
  readonly generalThreadId: number | null;
  readonly fingerprint: string | undefined;
  readonly topics: number;
  readonly sessions: number;
  readonly mirrors: number;
  readonly offset: number | null;
  readonly offsetUpdatedAtMs: number | null;
  readonly lastActivityMs: number | null;
};

const EMPTY_STATE: TelegramDurableState = {
  metaFound: false,
  generalThreadId: null,
  fingerprint: undefined,
  topics: 0,
  sessions: 0,
  mirrors: 0,
  offset: null,
  offsetUpdatedAtMs: null,
  lastActivityMs: null,
};

/** Full status report rendered by the command. */
export type TelegramStatusReport = {
  readonly toggleEnabled: boolean;
  readonly enabled: boolean;
  readonly reason: string | undefined;
  readonly missingVars: readonly string[];
  readonly fingerprint: string | undefined;
  readonly tokenOk: boolean;
  readonly botUsername: string | undefined;
  readonly tokenError: string | undefined;
  readonly state: TelegramDurableState;
  readonly restartLikely: boolean;
  readonly verdict: string;
};

type ProbeResult = {
  readonly ok: boolean;
  readonly username?: string;
  readonly error?: string;
};

/** Injectable seams so the report is testable without network, database, or real tokens. */
export type TelegramStatusOptions = {
  readonly cwd?: string;
  readonly configDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly loadConfig?: () => Promise<{ plugins?: unknown; telegram?: unknown }>;
  readonly probeToken?: (token: string, apiRoot: string | undefined) => Promise<ProbeResult>;
  readonly readState?: () => Promise<TelegramDurableState>;
  readonly configMtimeMs?: number | undefined;
  readonly logMtimeMs?: number | undefined;
};

function mtimeMs(path: string): number | undefined {
  try {
    return existsSync(path) ? statSync(path).mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" ? value : null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read durable bridge state from the OpenCode kv table; any failure yields the empty state. */
async function readDurableState(): Promise<TelegramDurableState> {
  try {
    const dbPath = join(getDataHome(), "opencode", "opencode.db");
    if (!existsSync(dbPath)) return EMPTY_STATE;
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    try {
      const meta = db
        .query(
          "select key, value, time_updated from kv where key like '%:telegram/v1/meta' order by time_updated desc limit 1",
        )
        .get() as Record<string, unknown> | null;
      if (meta === null) return EMPTY_STATE;
      const metaKey = stringField(meta, "key");
      if (metaKey === undefined) return EMPTY_STATE;
      const prefix = metaKey.slice(0, metaKey.length - "telegram/v1/meta".length);
      const metaValue = (() => {
        try {
          return JSON.parse(String(meta.value)) as Record<string, unknown>;
        } catch {
          return {} as Record<string, unknown>;
        }
      })();
      const count = (suffix: string): number => {
        const row = db
          .query("select count(*) as n from kv where key like ?")
          .get(`${prefix}telegram/v1/${suffix}/%`) as Record<string, unknown> | null;
        return typeof row?.n === "number" ? row.n : 0;
      };
      const offsetRow = db
        .query("select value, time_updated from kv where key = ?")
        .get(`${prefix}telegram/v1/offset`) as Record<string, unknown> | null;
      const activityRow = db
        .query("select max(time_updated) as m from kv where key like ?")
        .get(`${prefix}telegram/v1/%`) as Record<string, unknown> | null;
      const offsetValue = offsetRow === null ? null : Number(String(offsetRow.value));
      return {
        metaFound: true,
        generalThreadId: numberField(metaValue, "generalThreadId"),
        fingerprint: stringField(metaValue, "fingerprint"),
        topics: count("topic"),
        sessions: count("session"),
        mirrors: count("mirror"),
        offset: Number.isFinite(offsetValue) ? offsetValue : null,
        offsetUpdatedAtMs: offsetRow === null ? null : numberField(offsetRow, "time_updated"),
        lastActivityMs: activityRow === null ? null : numberField(activityRow, "m"),
      };
    } finally {
      db.close();
    }
  } catch {
    return EMPTY_STATE;
  }
}

/** Probe the token with getMe; every failure is normalized and the token is redacted. */
async function probeToken(token: string, apiRoot: string | undefined): Promise<ProbeResult> {
  const base =
    apiRoot !== undefined && apiRoot.trim().length > 0
      ? apiRoot.replace(/\/+$/, "")
      : "https://api.telegram.org";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let response: Response;
    try {
      response = await fetch(`${base}/bot${token}/getMe`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const body = (await response.json().catch(() => undefined)) as
      | { ok?: boolean; result?: { username?: string }; description?: string }
      | undefined;
    if (body?.ok === true && body.result !== undefined) {
      return { ok: true, username: body.result.username };
    }
    return { ok: false, error: body?.description ?? `HTTP ${response.status}` };
  } catch (error) {
    const raw = error instanceof Error ? error.message : "unreachable";
    return { ok: false, error: raw.split(token).join("[redacted]") };
  }
}

// START_CONTRACT: collectTelegramStatus
//   PURPOSE: Build the Telegram status report from the effective config plus injectable probe and state seams.
//   INPUTS: { options: TelegramStatusOptions - cwd, config dir, env, and injectable seams }
//   OUTPUTS: { TelegramStatusReport - resolved causes, token probe, durable state, and verdict }
//   SIDE_EFFECTS: reads the vvoc config, the OpenCode kv table, and optionally calls the Telegram API
//   LINKS: M-CLI-COMMANDS, M-TELEGRAM-CONFIG
// END_CONTRACT: collectTelegramStatus
export async function collectTelegramStatus(
  options: TelegramStatusOptions = {},
): Promise<TelegramStatusReport> {
  const env = options.env ?? process.env;
  const loadConfig =
    options.loadConfig ??
    (async () =>
      (await loadEffectiveVvocConfig({ cwd: options.cwd, configDir: options.configDir })).config);
  const probe = options.probeToken ?? probeToken;
  const state = options.readState ?? readDurableState;

  let config: { plugins?: unknown; telegram?: unknown };
  try {
    config = await loadConfig();
  } catch (error) {
    return {
      toggleEnabled: false,
      enabled: false,
      reason: `config error: ${error instanceof Error ? error.message : "unreadable"}`,
      missingVars: [],
      fingerprint: undefined,
      tokenOk: false,
      botUsername: undefined,
      tokenError: undefined,
      state: EMPTY_STATE,
      restartLikely: false,
      verdict: "config could not be loaded",
    };
  }

  const toggleEnabled = isVvocPluginEnabled(config as { plugins?: never }, "telegram");
  const resolved = resolveTelegramConfig(config.telegram as VvocTelegramConfig | undefined, env);
  const durable = await state();

  const configMtime = options.configMtimeMs ?? mtimeMs(getGlobalVvocConfigPath(options.configDir));
  const logMtime = options.logMtimeMs ?? mtimeMs(getTelegramLogPath());
  const restartLikely =
    configMtime !== undefined && logMtime !== undefined && configMtime > logMtime;

  if (!toggleEnabled) {
    return {
      toggleEnabled,
      enabled: false,
      reason: "toggle-disabled",
      missingVars: [],
      fingerprint: undefined,
      tokenOk: false,
      botUsername: undefined,
      tokenError: undefined,
      state: durable,
      restartLikely,
      verdict: "plugins.telegram is false: the gateway registers nothing",
    };
  }
  if (!resolved.enabled) {
    const suffix =
      resolved.missingVars.length > 0 ? ` (missing: ${resolved.missingVars.join(", ")})` : "";
    return {
      toggleEnabled,
      enabled: false,
      reason: resolved.reason,
      missingVars: resolved.missingVars,
      fingerprint: undefined,
      tokenOk: false,
      botUsername: undefined,
      tokenError: undefined,
      state: durable,
      restartLikely,
      verdict: `gateway disabled — ${resolved.reason}${suffix}`,
    };
  }

  const fingerprint = telegramBotFingerprint(resolved.botToken);
  const probed = await probe(resolved.botToken, resolved.apiRoot);

  const verdict = ((): string => {
    if (!probed.ok) return `token probe failed: ${probed.error ?? "unknown error"}`;
    if (!durable.metaFound)
      return "token is valid but no durable state exists yet (the gateway may not have booted)";
    if (durable.fingerprint !== undefined && durable.fingerprint !== fingerprint) {
      return "stored state belongs to a different token: it resets on the next boot";
    }
    if (restartLikely)
      return "config changed after the last gateway boot: restart OpenCode to apply";
    if (
      durable.offsetUpdatedAtMs !== null &&
      Date.now() - durable.offsetUpdatedAtMs > 15 * 60_000
    ) {
      return "polling looks stale: the update offset has not advanced for over 15 minutes";
    }
    return "healthy";
  })();

  return {
    toggleEnabled,
    enabled: true,
    reason: undefined,
    missingVars: [],
    fingerprint,
    tokenOk: probed.ok,
    botUsername: probed.username,
    tokenError: probed.error,
    state: durable,
    restartLikely,
    verdict,
  };
}

function ageLabel(ms: number | null): string {
  if (ms === null) return "never";
  const delta = Date.now() - ms;
  if (delta < 60_000) return `${Math.max(0, Math.round(delta / 1000))}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  return `${Math.round(delta / 3_600_000)}h ago`;
}

/** Render a status report as human-readable lines. */
export function renderTelegramStatus(report: TelegramStatusReport): void {
  console.log("vvoc Telegram bridge status");
  console.log(`  plugin toggle:   ${report.toggleEnabled ? "enabled" : "disabled"}`);
  console.log(
    `  gateway:         ${report.enabled ? "enabled" : `disabled (${report.reason ?? "unknown"})`}`,
  );
  if (report.missingVars.length > 0) {
    console.log(`  unresolved vars: ${report.missingVars.join(", ")}`);
  }
  if (report.fingerprint !== undefined) {
    console.log(`  bot fingerprint: ${report.fingerprint}`);
  }
  if (report.enabled) {
    console.log(
      `  token probe:     ${report.tokenOk ? `ok${report.botUsername ? ` (@${report.botUsername})` : ""}` : `failed (${report.tokenError ?? "unknown"})`}`,
    );
    console.log(`  General topic:   ${report.state.generalThreadId ?? "unknown"}`);
    console.log(
      `  surface:         ${report.state.topics} topics, ${report.state.sessions} sessions, ${report.state.mirrors} mirrors`,
    );
    console.log(
      `  update offset:   ${report.state.offset ?? "none"} (${ageLabel(report.state.offsetUpdatedAtMs)})`,
    );
    console.log(`  last activity:   ${ageLabel(report.state.lastActivityMs)}`);
  }
  if (report.restartLikely) {
    console.log("  restart:         config is newer than the last gateway boot");
  }
  console.log(`  verdict:         ${report.verdict}`);
}

export default defineCommand({
  meta: {
    name: "status",
    description: "Show the vvoc Telegram bridge configuration, token, and durable gateway state.",
  },
  args: {
    json: {
      type: "boolean",
      default: false,
      description: "Emit the report as JSON.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home used for vvoc/ and opencode/.",
    },
  },
  async run({ args }) {
    const report = await collectTelegramStatus({
      configDir: typeof args["config-dir"] === "string" ? args["config-dir"] : undefined,
    });
    if (args.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    renderTelegramStatus(report);
  },
});
