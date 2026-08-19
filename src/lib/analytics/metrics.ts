// FILE: src/lib/analytics/metrics.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Pure analytics dedupe, filtering, grouping, metric computation, and CLI formatting helpers with UTC-deterministic time buckets.
//   SCOPE: Last-write-wins dedupe by partID, ISO week bucketing, group key extraction, token-weighted cache hit rate and coverage, inclusive range/project filters, relative and absolute date parsing, and compact display formatting.
//   DEPENDS: [src/lib/analytics/types.ts]
//   LINKS: [M-ANALYTICS-TYPES, M-CLI-ANALYTICS, M-TUI-ANALYTICS-INDICATOR]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   dedupeUsageRecords - Keeps the last occurrence of each partID in array order.
//   isoWeekKey - ISO week key "YYYY-Wnn" for a UTC timestamp.
//   groupKeyOf - Group key extraction for a usage record.
//   computeGroupedMetrics - Aggregates deduped usage records into per-group metrics.
//   UsageFilter - Inclusive date-range and project-substring filter shape.
//   filterUsageRecords - Applies inclusive date-range and project-substring filters.
//   parseSinceUntil - Parses relative and absolute --since/--until values.
//   formatTokenCount - Compact human token count formatting.
//   formatHitRate - Percentage or "n/a" formatting for nullable hit rates.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-19-cache-hit-rate-analytics - Added pure analytics metrics and formatting helpers.]
// END_CHANGE_SUMMARY

import type { AnalyticsGroupKey, GroupedMetrics, UsageRecord } from "./types.js";

const DAY_MS = 86_400_000;

// START_BLOCK_DEDUPE
/** Keeps only the last occurrence of each partID in array order (last-write-wins). */
export function dedupeUsageRecords(records: UsageRecord[]): UsageRecord[] {
  const byPart = new Map<string, UsageRecord>();
  for (const record of records) byPart.set(record.partID, record);
  return [...byPart.values()];
}
// END_BLOCK_DEDUPE

// START_BLOCK_TIME_BUCKETS
/** ISO week key "YYYY-Wnn" for a UTC timestamp. */
export function isoWeekKey(ts: string): string {
  const date = new Date(ts);
  const dayNr = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNr + 3);
  const year = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Group key extraction; day/week/month buckets are UTC-based. */
export function groupKeyOf(record: UsageRecord, groupBy: AnalyticsGroupKey): string {
  switch (groupBy) {
    case "session":
      return record.sessionID;
    case "day":
      return record.ts.slice(0, 10);
    case "week":
      return isoWeekKey(record.ts);
    case "month":
      return record.ts.slice(0, 7);
    case "model":
      return `${record.providerID}/${record.modelID}`;
    case "provider":
      return record.providerID;
    case "project":
      return record.projectDirectory;
    case "vvoc":
      return record.vvocVersion;
    case "opencode":
      return record.opencodeVersion;
  }
}
// END_BLOCK_TIME_BUCKETS

// START_BLOCK_GROUPED_METRICS
/**
 * Aggregates usage records into per-group metrics.
 * hitRate = sum(cacheRead) / sum(cacheRead + cacheWrite + input) over eligible
 * steps (cacheRead + cacheWrite > 0); null when a group has no eligible steps.
 */
export function computeGroupedMetrics(
  usage: UsageRecord[],
  groupBy: AnalyticsGroupKey,
): GroupedMetrics[] {
  const groups = new Map<string, GroupedMetrics>();
  for (const record of usage) {
    const key = groupKeyOf(record, groupBy);
    const group = groups.get(key) ?? {
      key,
      steps: 0,
      eligibleSteps: 0,
      coverage: 0,
      hitRate: null,
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
      reasoning: 0,
    };
    group.steps += 1;
    group.cacheRead += record.tokens.cacheRead;
    group.cacheWrite += record.tokens.cacheWrite;
    group.input += record.tokens.input;
    group.output += record.tokens.output;
    group.reasoning += record.tokens.reasoning;
    if (record.tokens.cacheRead + record.tokens.cacheWrite > 0) group.eligibleSteps += 1;
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    group.coverage = group.steps > 0 ? group.eligibleSteps / group.steps : 0;
    const denominator = group.cacheRead + group.cacheWrite + group.input;
    group.hitRate =
      group.eligibleSteps > 0 && denominator > 0 ? group.cacheRead / denominator : null;
  }
  return [...groups.values()];
}
// END_BLOCK_GROUPED_METRICS

// START_BLOCK_FILTERS
export type UsageFilter = {
  /** Inclusive lower date bound "YYYY-MM-DD" (UTC). */
  since?: string;
  /** Inclusive upper date bound "YYYY-MM-DD" (UTC). */
  until?: string;
  /** Case-insensitive substring matched against projectDirectory. */
  project?: string;
};

/** Applies inclusive date-range and project-substring filters. */
export function filterUsageRecords(usage: UsageRecord[], filter: UsageFilter): UsageRecord[] {
  const untilUpper = filter.until ? `${filter.until}T23:59:59.999Z` : undefined;
  const needle = filter.project?.toLowerCase();
  return usage.filter((record) => {
    if (filter.since && record.ts < `${filter.since}T00:00:00.000Z`) return false;
    if (untilUpper && record.ts > untilUpper) return false;
    if (needle && !record.projectDirectory.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/**
 * Parses a --since/--until value. Relative "Nd"/"Nw"/"Nm" resolve against `now`
 * as a UTC date string; absolute "YYYY-MM-DD" passes through. Returns undefined
 * for undefined input and null for unparseable input.
 */
export function parseSinceUntil(raw: string | undefined, now: Date): string | undefined | null {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().toLowerCase();
  const relative = /^(\d+)([dwm])$/.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = relative[2] === "d" ? DAY_MS : relative[2] === "w" ? 7 * DAY_MS : 30 * DAY_MS;
    return new Date(now.getTime() - amount * unitMs).toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  return null;
}
// END_BLOCK_FILTERS

// START_BLOCK_FORMATTERS
/** Compact human token count: 999 -> "999"; 1234 -> "1.2k"; 2100000 -> "2.1M". */
export function formatTokenCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** "n/a" for null; otherwise a percentage with one decimal. */
export function formatHitRate(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}
// END_BLOCK_FORMATTERS
