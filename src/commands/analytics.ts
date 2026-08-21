// FILE: src/commands/analytics.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide the vvoc analytics command with the cache-hit-rate aggregation subcommand.
//   SCOPE: Flag validation, store reading with env override, dedupe/filter/group pipeline, ordering, limits, JSON and table rendering, and the empty state.
//   DEPENDS: [citty, src/lib/analytics/store.ts, src/lib/analytics/metrics.ts, src/lib/analytics/types.ts]
//   LINKS: [M-ANALYTICS-STORE, M-ANALYTICS-METRICS, M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   GROUP_BY_VALUES - Supported --group-by values.
//   ORDER_VALUES - Supported --order values.
//   CacheHitRateRow - Row shape projected from grouped metrics for JSON and table output.
//   cacheHitRateCommand - cache-hit-rate subcommand definition.
//   orderGroups - Orders grouped metrics by date, steps, or hit rate.
//   sessionDisplayLabel - Resolves a session display label from session titles with a short-id fallback.
//   buildCacheHitRateRows - Projects groups and session titles into JSON/table rows.
//   renderCacheHitRateTable - Renders rows as a padded ASCII table.
//   default - analytics parent command registering cache-hit-rate.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-19-cache-hit-rate-analytics - Added analytics cache-hit-rate CLI command.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { readAnalyticsRecords } from "../lib/analytics/store.js";
import {
  computeGroupedMetrics,
  dedupeUsageRecords,
  filterUsageRecords,
  formatHitRate,
  formatTokenCount,
  parseSinceUntil,
} from "../lib/analytics/metrics.js";
import type {
  AnalyticsGroupKey,
  AnalyticsRecord,
  GroupedMetrics,
  SessionRecord,
  UsageRecord,
} from "../lib/analytics/types.js";

export const GROUP_BY_VALUES: AnalyticsGroupKey[] = [
  "session",
  "day",
  "week",
  "month",
  "model",
  "provider",
  "project",
  "vvoc",
  "opencode",
];

export const ORDER_VALUES = ["date", "steps", "hit-rate"] as const;

export type CacheHitRateRow = {
  group: string;
  steps: number;
  eligibleSteps: number;
  coverage: number;
  hitRate: number | null;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  reasoning: number;
};

// START_BLOCK_ORDER_AND_ROWS
/** Orders groups: date desc (default), steps desc, or hit-rate desc with null lowest. */
export function orderGroups(groups: GroupedMetrics[], order: string): GroupedMetrics[] {
  const sorted = [...groups];
  if (order === "steps") {
    sorted.sort((a, b) => b.steps - a.steps);
  } else if (order === "hit-rate") {
    sorted.sort((a, b) => (b.hitRate ?? -1) - (a.hitRate ?? -1));
  } else {
    sorted.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  }
  return sorted;
}

/** Projects grouped metrics into JSON/table rows, labeling session groups with known titles. */
export function buildCacheHitRateRows(
  groups: GroupedMetrics[],
  groupBy: AnalyticsGroupKey,
  sessionTitles: Map<string, string>,
): CacheHitRateRow[] {
  return groups.map((group) => ({
    group: groupBy === "session" ? sessionDisplayLabel(group.key, sessionTitles) : group.key,
    steps: group.steps,
    eligibleSteps: group.eligibleSteps,
    coverage: group.coverage,
    hitRate: group.hitRate,
    cacheRead: group.cacheRead,
    cacheWrite: group.cacheWrite,
    input: group.input,
    output: group.output,
    reasoning: group.reasoning,
  }));
}

/** Session display label: latest known title plus a short session id. */
export function sessionDisplayLabel(sessionID: string, titles: Map<string, string>): string {
  const title = titles.get(sessionID);
  const short = sessionID.slice(0, 8);
  return title ? `${title} ${short}` : short;
}
// END_BLOCK_ORDER_AND_ROWS

// START_BLOCK_RENDER_TABLE
/** Renders cache hit rate rows as a padded ASCII table. */
export function renderCacheHitRateTable(rows: CacheHitRateRow[]): string {
  const header = [
    "GROUP",
    "STEPS",
    "COVERAGE",
    "HIT-RATE",
    "CACHE-READ",
    "CACHE-WRITE",
    "FRESH-IN",
  ];
  const lines = rows.map((row) => [
    row.group,
    String(row.steps),
    row.coverage.toFixed(2),
    formatHitRate(row.hitRate),
    formatTokenCount(row.cacheRead),
    formatTokenCount(row.cacheWrite),
    formatTokenCount(row.input),
  ]);
  const widths = header.map((_, index) =>
    Math.max(header[index].length, ...lines.map((line) => line[index].length)),
  );
  const render = (cells: string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]))
      .join("  ")
      .trimEnd();

  return [render(header), ...lines.map(render)].join("\n");
}
// END_BLOCK_RENDER_TABLE

// START_BLOCK_CACHE_HIT_RATE_COMMAND
export const cacheHitRateCommand = defineCommand({
  meta: {
    name: "cache-hit-rate",
    description: "Aggregate cache hit rate from persisted step telemetry.",
  },
  args: {
    since: {
      type: "string",
      description: "Include records from this date: Nd/Nw/Nm relative or absolute YYYY-MM-DD.",
    },
    until: {
      type: "string",
      description: "Include records up to this inclusive date (YYYY-MM-DD).",
    },
    "group-by": {
      type: "string",
      default: "day",
      description: `Grouping key: ${GROUP_BY_VALUES.join(", ")}.`,
    },
    project: {
      type: "string",
      description: "Case-insensitive project directory substring filter.",
    },
    limit: {
      type: "string",
      description: "Maximum number of rendered groups (default 30).",
    },
    order: {
      type: "string",
      default: "date",
      description: `Row ordering: ${ORDER_VALUES.join(", ")}.`,
    },
    json: {
      type: "boolean",
      default: false,
      description: "Print machine-readable JSON instead of a table.",
    },
  },
  async run({ args }) {
    const groupBy = String(args["group-by"] ?? "day");
    if (!GROUP_BY_VALUES.includes(groupBy as AnalyticsGroupKey)) {
      console.error(
        `Invalid --group-by value: ${groupBy} (expected one of ${GROUP_BY_VALUES.join(", ")})`,
      );
      process.exitCode = 1;
      return;
    }
    const order = String(args.order ?? "date");
    if (!(ORDER_VALUES as readonly string[]).includes(order)) {
      console.error(`Invalid --order value: ${order} (expected one of ${ORDER_VALUES.join(", ")})`);
      process.exitCode = 1;
      return;
    }
    const now = new Date();
    const since = parseSinceUntil(args.since === undefined ? undefined : String(args.since), now);
    if (since === null) {
      console.error(
        `Invalid --since value: ${String(args.since)} (expected Nd/Nw/Nm or YYYY-MM-DD)`,
      );
      process.exitCode = 1;
      return;
    }
    const until = parseSinceUntil(args.until === undefined ? undefined : String(args.until), now);
    if (until === null) {
      console.error(
        `Invalid --until value: ${String(args.until)} (expected YYYY-MM-DD or a relative form)`,
      );
      process.exitCode = 1;
      return;
    }

    const dataHomeOverride = resolveAnalyticsDataHomeOverride();
    const records = await readAnalyticsRecords({ dataHomeOverride });
    const usage = dedupeUsageRecords(
      records.filter((record): record is UsageRecord => record.kind === "usage"),
    );
    const sessionTitles = collectSessionTitles(records);
    const filtered = filterUsageRecords(usage, {
      since,
      until,
      project: args.project === undefined ? undefined : String(args.project),
    });
    const parsedLimit = Number.parseInt(String(args.limit ?? "30"), 10);
    const limit = Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 30);
    const ordered = orderGroups(
      computeGroupedMetrics(filtered, groupBy as AnalyticsGroupKey),
      order,
    ).slice(0, limit);
    const rows = buildCacheHitRateRows(ordered, groupBy as AnalyticsGroupKey, sessionTitles);

    if (args.json === true) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log("No analytics records matched the given filters.");
      return;
    }
    console.log(renderCacheHitRateTable(rows));
  },
});
// END_BLOCK_CACHE_HIT_RATE_COMMAND

export default defineCommand({
  meta: {
    name: "analytics",
    description: "Inspect persisted vvoc usage analytics.",
  },
  subCommands: {
    "cache-hit-rate": cacheHitRateCommand,
  },
});

/** Resolves the VVOC_ANALYTICS_DATA_HOME data-home override for tests and sandboxes. */
function resolveAnalyticsDataHomeOverride(): string | undefined {
  const value = process.env.VVOC_ANALYTICS_DATA_HOME;
  return value && value.trim() ? value.trim() : undefined;
}

/** Keeps the latest title per sessionID from session records. */
function collectSessionTitles(records: AnalyticsRecord[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const record of records) {
    if ((record as SessionRecord).kind === "session") {
      titles.set((record as SessionRecord).sessionID, (record as SessionRecord).title);
    }
  }
  return titles;
}
