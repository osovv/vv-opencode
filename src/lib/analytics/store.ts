// FILE: src/lib/analytics/store.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Append-only monthly JSONL persistence for analytics records under the global vvoc data root.
//   SCOPE: Analytics directory resolution, monthly file naming, record appending with idempotent directory creation, and tolerant chronological reads.
//   DEPENDS: [node:fs/promises, node:path, src/lib/vvoc-paths.ts, src/lib/analytics/types.ts]
//   LINKS: [M-ANALYTICS-TYPES, M-PLUGIN-ANALYTICS, M-CLI-ANALYTICS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   getAnalyticsDir - Resolves the analytics store directory inside the global vvoc data root.
//   resolveAnalyticsFileName - Monthly file name for a record timestamp.
//   appendAnalyticsRecord - Appends one record as a JSON line to the monthly file.
//   readAnalyticsRecords - Reads all usage-*.jsonl records in tolerant chronological order.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-19-cache-hit-rate-analytics - Added append-only monthly JSONL analytics store.]
// END_CHANGE_SUMMARY

import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getGlobalVvocDataDir } from "../vvoc-paths.js";
import type { AnalyticsRecord } from "./types.js";

const ANALYTICS_FILE_PATTERN = /^usage-\d{4}-\d{2}\.jsonl$/;

// START_BLOCK_ANALYTICS_DIR
/** Resolves the analytics store directory inside the global vvoc data root. */
export function getAnalyticsDir(dataHomeOverride?: string): string {
  return join(getGlobalVvocDataDir(dataHomeOverride), "analytics");
}

/** Monthly file name for a record timestamp: usage-YYYY-MM.jsonl. */
export function resolveAnalyticsFileName(ts: string): string {
  return `usage-${ts.slice(0, 7)}.jsonl`;
}
// END_BLOCK_ANALYTICS_DIR

// START_BLOCK_ANALYTICS_APPEND
/**
 * Appends one record as a JSON line to the monthly file.
 * Creates the analytics directory when missing; never rewrites existing lines.
 */
export async function appendAnalyticsRecord(
  record: AnalyticsRecord,
  options: { dataHomeOverride?: string } = {},
): Promise<void> {
  const dir = getAnalyticsDir(options.dataHomeOverride);
  await mkdir(dir, { recursive: true });
  const file = join(dir, resolveAnalyticsFileName(record.ts));
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}
// END_BLOCK_ANALYTICS_APPEND

// START_BLOCK_ANALYTICS_READ
/**
 * Reads every usage-*.jsonl file (sorted by file name ascending) and returns
 * parsed records in file-then-line order. Empty and unparsable lines are
 * skipped without failing. A missing directory returns an empty array.
 */
export async function readAnalyticsRecords(
  options: { dataHomeOverride?: string } = {},
): Promise<AnalyticsRecord[]> {
  const dir = getAnalyticsDir(options.dataHomeOverride);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((name) => ANALYTICS_FILE_PATTERN.test(name)).sort();
  } catch {
    return [];
  }

  const records: AnalyticsRecord[] = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as AnalyticsRecord);
      } catch {
        // Corrupt or partially written line: skip.
      }
    }
  }
  return records;
}
// END_BLOCK_ANALYTICS_READ
