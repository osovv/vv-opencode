// FILE: src/lib/plugin-toggle-config.ts
// VERSION: 1.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Define canonical plugin toggle names, default-all-true values, and a pure plugin-enabled helper for loaded vvoc config snapshots.
//   SCOPE: Plugin name constants, default config builder, default hashline edit-routing table, default tool-history-compaction entry, revision-dated default peak-hours schedules and entry, conservative plugin entry materialization, pure toggle checks, and the toggle config type.
//   DEPENDS: [none]
//   LINKS: [M-PLUGIN-TOGGLE-CONFIG, M-CLI-CONFIG, M-PEAK-HOURS-SCHEDULES]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PLUGIN_TOGGLE_NAMES - Canonical list of vvoc-managed plugin names.
//   VvocPluginToggleConfig - Type alias mapping plugin names to boolean toggles or object entries.
//   VvocPluginEntryConfig - Object-form plugin entry with optional enabled flag and plugin-owned routing config.
//   createDefaultPluginToggleConfig - Returns a Record with all known plugins set to true.
//   DEFAULT_HASHLINE_EDIT_ROUTING - Default edit-routing table materialized into vvoc.json for the hashline-edit plugin.
//   DEFAULT_TOOL_HISTORY_COMPACTION_RETAIN_TOOLS - Default knowledge-tool retention substrings for tool-history-compaction.
//   DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY - Default materializable config entry for tool-history-compaction.
//   DEFAULT_PEAK_HOURS_SCHEDULES_REVISION - Revision date of the built-in peak-hours schedule data.
//   DEFAULT_PEAK_HOURS_SCHEDULES - Revision-dated built-in provider peak windows for the peak-hours plugin.
//   DEFAULT_PEAK_HOURS_ENTRY - Default materializable config entry for the peak-hours plugin.
//   materializeHashlineEditEntry - Expand the hashline-edit entry so the routing table is present without overwriting user values.
//   materializeToolHistoryCompactionEntry - Expand the tool-history-compaction entry so the compaction config is present without overwriting user values.
//   materializePeakHoursEntry - Expand the peak-hours entry so defaults are present without overwriting user values.
//   isPluginEnabled - Returns whether the named plugin is enabled in a loaded vvoc config object.
//   isVvocPluginEnabled - Alias for isPluginEnabled with explicit vvoc naming.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-PLUGIN-PEAK-HOURS - Added the peak-hours toggle name, revision-dated default schedules, and conservative entry materialization.]
// END_CHANGE_SUMMARY

// START_BLOCK_CONSTANTS
export const PLUGIN_TOGGLE_NAMES = [
  "guardian",
  "hashline-edit",
  "model-roles",
  "system-context-injection",
  "workflow",
  "secrets-redaction",
  "context",
  "web-tools",
  "tool-history-compaction",
  "analytics",
  "peak-hours",
] as const;

export type VvocPluginEntryConfig = {
  enabled?: boolean;
  routing?: Record<string, unknown>;
} & Record<string, unknown>;

export type VvocPluginToggleConfig = Record<string, boolean | VvocPluginEntryConfig>;

// Default edit-routing table for the hashline-edit plugin. Materialized into vvoc.json
// on sync/init so it is visible and editable; kept as a plain config-shape object
// (rules as a pattern->mode record). The plugin converts it to its runtime form.
export const DEFAULT_HASHLINE_EDIT_ROUTING = {
  default: "hashline",
  rules: {
    deepseek: "str_replace_editor",
    kimi: "replace",
    qwen: "replace",
    glm: "replace",
    gpt: "passthrough",
    codex: "passthrough",
  },
} as const;
// END_BLOCK_CONSTANTS

// START_BLOCK_TOOL_HISTORY_DEFAULTS
// Default retention list and materializable entry for the tool-history-compaction plugin.
export const DEFAULT_TOOL_HISTORY_COMPACTION_RETAIN_TOOLS = [
  "webfetch",
  "web_fetch",
  "web-reader",
  "webreader",
  "search",
  "brave",
  "skill",
  "task",
  "agent",
] as const;

export const DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY = {
  enabled: true,
  protectLastCalls: 3,
  protectRecentMessages: 8,
  savePrunedOutput: true,
  minSavingsChars: 2000,
  outputMaxChars: 2048,
  headChars: 1200,
  tailChars: 400,
  readSlim: true,
  retainTools: [...DEFAULT_TOOL_HISTORY_COMPACTION_RETAIN_TOOLS],
} as const;
// END_BLOCK_TOOL_HISTORY_DEFAULTS

// START_BLOCK_PEAK_HOURS_DEFAULTS
// Revision-dated best-effort peak windows verified on 2026-08-21 from provider
// documentation; users own their copy after materialization and providers move
// these clocks. deepseek: x2 surcharge windows effective 2026-08-16
// (api-docs.deepseek.com). z-ai: GLM Coding Plan weekday clock, 14:00-18:00
// UTC+8 (docs.z.ai), matching the zai-coding-plan and zhipuai-coding-plan
// provider ids. qwen: Alibaba Token Plan off-peak 22:00-08:00 UTC+8, i.e. peak
// 00:00-14:00 UTC daily, matching the alibaba-token-plan and
// alibaba-token-plan-cn provider ids. Bare pay-per-token API providers (zai,
// zhipuai, alibaba, alibaba-cn) publish no peak surcharge and are never gated.
export const DEFAULT_PEAK_HOURS_SCHEDULES_REVISION = "2026-08-21";

export const DEFAULT_PEAK_HOURS_SCHEDULES = {
  deepseek: {
    windows: [
      { start: "01:00", end: "04:00", tz: "UTC" },
      { start: "06:00", end: "10:00", tz: "UTC" },
    ],
  },
  "z-ai": {
    windows: [{ start: "06:00", end: "10:00", tz: "UTC", days: [1, 2, 3, 4, 5] }],
  },
  qwen: {
    windows: [{ start: "00:00", end: "14:00", tz: "UTC" }],
  },
} as const;

export const DEFAULT_PEAK_HOURS_ENTRY = {
  enabled: true,
  mode: "soft",
  graceActiveSessions: true,
  schedules: DEFAULT_PEAK_HOURS_SCHEDULES,
} as const;
// END_BLOCK_PEAK_HOURS_DEFAULTS

// START_BLOCK_DEFAULT_CONFIG
export function createDefaultPluginToggleConfig(): VvocPluginToggleConfig {
  const config: VvocPluginToggleConfig = {};
  for (const name of PLUGIN_TOGGLE_NAMES) {
    config[name] = true;
  }
  return config;
}
// END_BLOCK_DEFAULT_CONFIG

// START_BLOCK_HASHLINE_ROUTING_MATERIALIZE
function defaultHashlineRoutingCopy(): Record<string, unknown> {
  return {
    default: DEFAULT_HASHLINE_EDIT_ROUTING.default,
    rules: { ...DEFAULT_HASHLINE_EDIT_ROUTING.rules },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Materialize the hashline-edit plugin entry so the edit-routing table is always
 * present in vvoc.json. Conservative: a user value that differs from the default
 * is never overwritten. Boolean or missing entries expand to the full object with
 * the default routing table; object entries keep their enabled flag and routing
 * block when present, filling routing with the default only when it is absent.
 */
export function materializeHashlineEditEntry(
  current: boolean | VvocPluginEntryConfig | undefined,
): VvocPluginEntryConfig {
  if (current === undefined || typeof current === "boolean") {
    return {
      enabled: current === undefined ? true : current,
      routing: defaultHashlineRoutingCopy(),
    };
  }

  const materialized: VvocPluginEntryConfig = {
    enabled: current.enabled ?? true,
  };
  materialized.routing = isPlainRecord(current.routing)
    ? current.routing
    : defaultHashlineRoutingCopy();
  return materialized;
}
// END_BLOCK_HASHLINE_ROUTING_MATERIALIZE

// START_BLOCK_TOOL_HISTORY_MATERIALIZE
function defaultToolHistoryCompactionCopy(): Record<string, unknown> {
  return {
    protectLastCalls: DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY.protectLastCalls,
    protectRecentMessages: DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY.protectRecentMessages,
    savePrunedOutput: DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY.savePrunedOutput,
    minSavingsChars: DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY.minSavingsChars,
    outputMaxChars: DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY.outputMaxChars,
    headChars: DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY.headChars,
    tailChars: DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY.tailChars,
    readSlim: DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY.readSlim,
    retainTools: [...DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY.retainTools],
  };
}

/**
 * Materialize the tool-history-compaction plugin entry so the compaction config is
 * always present in vvoc.json. Conservative: user values are never overwritten;
 * boolean or missing entries expand to the full default entry; object entries keep
 * their enabled flag and any user-provided config keys, filling only absent keys
 * with defaults.
 */
export function materializeToolHistoryCompactionEntry(
  current: boolean | VvocPluginEntryConfig | undefined,
): VvocPluginEntryConfig {
  const defaults = defaultToolHistoryCompactionCopy();
  if (current === undefined || typeof current === "boolean") {
    return {
      enabled: current === undefined ? true : current,
      ...defaults,
    };
  }
  const materialized: VvocPluginEntryConfig = {
    ...defaults,
    enabled: current.enabled ?? true,
  };
  for (const key of Object.keys(defaults)) {
    if (current[key] !== undefined) {
      materialized[key] = current[key];
    }
  }
  return materialized;
}
// END_BLOCK_TOOL_HISTORY_MATERIALIZE

// START_BLOCK_PEAK_HOURS_MATERIALIZE
function defaultPeakHoursSchedulesCopy(): Record<string, unknown> {
  return {
    deepseek: {
      windows: DEFAULT_PEAK_HOURS_SCHEDULES.deepseek.windows.map((window) => ({ ...window })),
    },
    "z-ai": {
      windows: DEFAULT_PEAK_HOURS_SCHEDULES["z-ai"].windows.map((window) => ({ ...window })),
    },
    qwen: {
      windows: DEFAULT_PEAK_HOURS_SCHEDULES.qwen.windows.map((window) => ({ ...window })),
    },
  };
}

/**
 * Materialize the peak-hours plugin entry so defaults are always present in
 * vvoc.json. Conservative: user values are never overwritten. Boolean or
 * missing entries expand to the full default entry with the revision-dated
 * schedules; object entries keep their enabled flag, mode, grace flag, and any
 * user-provided schedules object, filling only absent keys with defaults.
 */
export function materializePeakHoursEntry(
  current: boolean | VvocPluginEntryConfig | undefined,
): VvocPluginEntryConfig {
  if (current === undefined || typeof current === "boolean") {
    return {
      enabled: current === undefined ? true : current,
      mode: DEFAULT_PEAK_HOURS_ENTRY.mode,
      graceActiveSessions: DEFAULT_PEAK_HOURS_ENTRY.graceActiveSessions,
      schedules: defaultPeakHoursSchedulesCopy(),
    };
  }

  return {
    enabled: current.enabled ?? true,
    mode: current.mode ?? DEFAULT_PEAK_HOURS_ENTRY.mode,
    graceActiveSessions:
      current.graceActiveSessions ?? DEFAULT_PEAK_HOURS_ENTRY.graceActiveSessions,
    schedules: isPlainRecord(current.schedules)
      ? current.schedules
      : defaultPeakHoursSchedulesCopy(),
  };
}
// END_BLOCK_PEAK_HOURS_MATERIALIZE

// START_CONTRACT: isPluginEnabled
//   PURPOSE: Return whether the named plugin is enabled in an already-loaded vvoc config.
//   INPUTS: { config: { plugins?: VvocPluginToggleConfig } - loaded vvoc config or compatible plugin toggle holder; pluginName: string - one of PLUGIN_TOGGLE_NAMES }
//   OUTPUTS: { boolean - true if the plugin is enabled or the plugins section is absent, false if explicitly disabled }
//   SIDE_EFFECTS: none
//   LINKS: loadVvocConfig
// END_CONTRACT: isPluginEnabled
// START_BLOCK_VALIDATE_INPUT
export function isPluginEnabled(
  config: { plugins?: VvocPluginToggleConfig },
  pluginName: string,
): boolean {
  // END_BLOCK_VALIDATE_INPUT
  // START_BLOCK_IS_PLUGIN_ENABLED

  const pluginValue = config.plugins?.[pluginName];
  // If the specific plugin is not listed, default to enabled
  if (pluginValue === undefined) {
    return true;
  }

  if (typeof pluginValue === "boolean") {
    if (process.env.DEBUG?.includes("vvoc")) {
      console.log(
        "[plugin-toggle][isPluginEnabled][BLOCK_CHECK_PLUGIN_ENABLED] plugin " +
          pluginName +
          " enabled: " +
          pluginValue,
      );
    }
    return pluginValue;
  }

  // Object entry: enabled defaults to true; plugin-owned sections do not disable it.
  return pluginValue.enabled !== false;
}

export const isVvocPluginEnabled = isPluginEnabled;
// END_BLOCK_IS_PLUGIN_ENABLED
