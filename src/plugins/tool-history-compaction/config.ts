// FILE: src/plugins/tool-history-compaction/config.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Define strict tool-history-compaction configuration parsing, validation, and defaults.
//   SCOPE: Config vocabulary, fail-loud validation of budgets and invariants, boolean-or-object plugin entry parsing, and the default materializable entry for vvoc sync.
//   DEPENDS: [src/plugins/tool-history-compaction/retention.ts]
//   LINKS: [M-PLUGIN-TOOL-HISTORY-COMPACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ToolHistoryCompactionConfig - Resolved immutable compaction settings.
//   ResolvedToolHistoryCompactionEntry - Enabled flag plus resolved config from an entry.
//   DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY - Default vvoc materializable plugin entry.
//   DEFAULT_TOOL_HISTORY_COMPACTION - Resolved default config.
//   resolveConfig - Strictly resolve a partial config record against defaults.
//   parseToolHistoryCompactionEntry - Strictly parse the plugins entry into enabled flag and config.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Established config parsing with DSH-style head/tail budgets, retention list, protected tail, and min-savings guard.]
// END_CHANGE_SUMMARY

import { type RetainTools } from "./retention.js";
import { PRUNE_MARKER } from "./prune.js";
import { DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY } from "../../lib/plugin-toggle-config.js";

// START_BLOCK_VOCABULARY

export interface ToolHistoryCompactionConfig {
  /** Number of most recent completed tool calls (plus the last assistant message) never rewritten. */
  protectLastCalls: number;
  /** Minimum character savings for a rewrite to be applied; smaller rewrites are skipped. */
  minSavingsChars: number;
  /** Prune when output text exceeds this many code points; 0 disables pruning. */
  outputMaxChars: number;
  /** Leading code points retained when pruning. */
  headChars: number;
  /** Trailing code points retained when pruning. */
  tailChars: number;
  /** Replace old read outputs with a [Read <file>] header instead of pruning them. */
  readSlim: boolean;
  /** Tool names (case-insensitive substrings) whose outputs are never compacted. */
  retainTools: RetainTools;
}

export interface ResolvedToolHistoryCompactionEntry {
  enabled: boolean;
  config: ToolHistoryCompactionConfig;
}
// END_BLOCK_VOCABULARY

// START_BLOCK_DEFAULTS
export { DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY };
// END_BLOCK_DEFAULTS

// START_BLOCK_PARSE

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CONFIG_KEYS = new Set([
  "protectLastCalls",
  "minSavingsChars",
  "outputMaxChars",
  "headChars",
  "tailChars",
  "readSlim",
  "retainTools",
]);

function parseNonNegativeInt(raw: unknown, key: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new Error(
      `tool-history-compaction: ${key} must be a non-negative integer; got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function parseRetainTools(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error("tool-history-compaction: retainTools must be an array of non-empty strings");
  }
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error("tool-history-compaction: retainTools entries must be non-empty strings");
    }
  }
  return [...raw];
}

function assertBudgetsFit(config: ToolHistoryCompactionConfig): void {
  if (config.outputMaxChars > 0) {
    const required = config.headChars + config.tailChars + PRUNE_MARKER.length;
    if (required > config.outputMaxChars) {
      throw new Error(
        `tool-history-compaction: headChars + tailChars + marker (${required}) must fit within outputMaxChars (${config.outputMaxChars})`,
      );
    }
  }
}

/** Resolve a partial config record against defaults, failing loudly on unknown keys or invalid values. */
export function resolveConfig(raw: unknown): ToolHistoryCompactionConfig {
  if (raw === undefined || raw === null) {
    return { ...DEFAULT_TOOL_HISTORY_COMPACTION };
  }
  if (!isRecord(raw)) {
    throw new Error("tool-history-compaction: config must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`tool-history-compaction: unknown config key "${key}"`);
    }
  }

  const readSlim =
    raw.readSlim === undefined ? DEFAULT_TOOL_HISTORY_COMPACTION.readSlim : raw.readSlim;
  if (typeof readSlim !== "boolean") {
    throw new Error(
      `tool-history-compaction: readSlim must be a boolean; got ${JSON.stringify(raw.readSlim)}`,
    );
  }

  const resolved: ToolHistoryCompactionConfig = {
    protectLastCalls:
      raw.protectLastCalls === undefined
        ? DEFAULT_TOOL_HISTORY_COMPACTION.protectLastCalls
        : parseNonNegativeInt(raw.protectLastCalls, "protectLastCalls"),
    minSavingsChars:
      raw.minSavingsChars === undefined
        ? DEFAULT_TOOL_HISTORY_COMPACTION.minSavingsChars
        : parseNonNegativeInt(raw.minSavingsChars, "minSavingsChars"),
    outputMaxChars:
      raw.outputMaxChars === undefined
        ? DEFAULT_TOOL_HISTORY_COMPACTION.outputMaxChars
        : parseNonNegativeInt(raw.outputMaxChars, "outputMaxChars"),
    headChars:
      raw.headChars === undefined
        ? DEFAULT_TOOL_HISTORY_COMPACTION.headChars
        : parseNonNegativeInt(raw.headChars, "headChars"),
    tailChars:
      raw.tailChars === undefined
        ? DEFAULT_TOOL_HISTORY_COMPACTION.tailChars
        : parseNonNegativeInt(raw.tailChars, "tailChars"),
    readSlim,
    retainTools:
      raw.retainTools === undefined
        ? [...DEFAULT_TOOL_HISTORY_COMPACTION.retainTools]
        : parseRetainTools(raw.retainTools),
  };

  assertBudgetsFit(resolved);
  return resolved;
}

/** Parse the plugins["tool-history-compaction"] boolean-or-object union. */
export function parseToolHistoryCompactionEntry(raw: unknown): ResolvedToolHistoryCompactionEntry {
  if (raw === undefined || raw === null) {
    return { enabled: true, config: { ...DEFAULT_TOOL_HISTORY_COMPACTION } };
  }
  if (typeof raw === "boolean") {
    return { enabled: raw, config: { ...DEFAULT_TOOL_HISTORY_COMPACTION } };
  }
  if (!isRecord(raw)) {
    throw new Error(
      'tool-history-compaction: plugins["tool-history-compaction"] must be a boolean or an object',
    );
  }
  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof enabled !== "boolean") {
    throw new Error("tool-history-compaction: enabled must be a boolean");
  }
  const { enabled: _ignored, ...configRaw } = raw;
  return { enabled, config: resolveConfig(configRaw) };
}
// END_BLOCK_PARSE

// START_BLOCK_DEFAULT_RESOLVE
// Computed after resolveConfig so module-level initialization stays free of TDZ hazards.
const defaultConfig = Object.fromEntries(
  Object.entries(DEFAULT_TOOL_HISTORY_COMPACTION_ENTRY).filter(([key]) => key !== "enabled"),
);
export const DEFAULT_TOOL_HISTORY_COMPACTION: ToolHistoryCompactionConfig =
  resolveConfig(defaultConfig);
// END_BLOCK_DEFAULT_RESOLVE
