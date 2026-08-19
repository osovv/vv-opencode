// FILE: src/lib/analytics/metrics.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify analytics dedupe, group key extraction, metric formulas, filters, date parsing, and formatting.
//   SCOPE: Last-write-wins dedupe, UTC day/week/month buckets, nullable hit rate and coverage, inclusive boundaries, case-insensitive project match, relative dates, and compact rendering.
//   DEPENDS: [bun:test, src/lib/analytics/metrics.ts, src/lib/analytics/types.ts]
//   LINKS: [M-ANALYTICS-METRICS, V-M-ANALYTICS-METRICS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   usage - Builds a usage record with overrides for metrics tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-19-cache-hit-rate-analytics - Added metrics coverage for formulas, buckets, filters, and formatting.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  computeGroupedMetrics,
  dedupeUsageRecords,
  filterUsageRecords,
  formatHitRate,
  formatTokenCount,
  groupKeyOf,
  isoWeekKey,
  parseSinceUntil,
} from "./metrics.js";
import type { UsageRecord } from "./types.js";

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    kind: "usage",
    ts: "2026-08-19T10:00:00.000Z",
    projectID: "p1",
    projectDirectory: "/home/al/dev/vv-opencode",
    sessionID: "ses_1",
    messageID: "msg_1",
    partID: "prt_1",
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
    agent: "build",
    tokens: { input: 100, output: 10, reasoning: 5, cacheRead: 900, cacheWrite: 100 },
    cost: 0.01,
    vvocVersion: "1.2.11",
    opencodeVersion: "1.18.2",
    ...overrides,
  };
}

describe("dedupeUsageRecords", () => {
  test("keeps the last record per partID and drops earlier duplicates", () => {
    const first = usage({
      partID: "p1",
      tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    });
    const second = usage({
      partID: "p1",
      tokens: { input: 9, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    });
    const other = usage({ partID: "p2" });
    const result = dedupeUsageRecords([first, second, other]);
    expect(result).toHaveLength(2);
    expect(result.find((record) => record.partID === "p1")?.tokens.input).toBe(9);
  });
});

describe("time buckets", () => {
  test("isoWeekKey returns known ISO week numbers", () => {
    expect(isoWeekKey("2026-01-01T12:00:00.000Z")).toBe("2026-W01");
    expect(isoWeekKey("2026-08-19T12:00:00.000Z")).toBe("2026-W34");
    expect(isoWeekKey("2027-01-01T12:00:00.000Z")).toBe("2026-W53");
  });

  test("day and month buckets slice the UTC timestamp", () => {
    const record = usage({ ts: "2026-08-19T23:30:00.000Z" });
    expect(groupKeyOf(record, "day")).toBe("2026-08-19");
    expect(groupKeyOf(record, "month")).toBe("2026-08");
  });
});

describe("groupKeyOf", () => {
  test("extracts identity-based keys", () => {
    const record = usage();
    expect(groupKeyOf(record, "session")).toBe("ses_1");
    expect(groupKeyOf(record, "model")).toBe("anthropic/claude-sonnet-4-5");
    expect(groupKeyOf(record, "provider")).toBe("anthropic");
    expect(groupKeyOf(record, "project")).toBe("/home/al/dev/vv-opencode");
    expect(groupKeyOf(record, "vvoc")).toBe("1.2.11");
    expect(groupKeyOf(record, "opencode")).toBe("1.18.2");
  });
});

describe("computeGroupedMetrics", () => {
  test("computes token-weighted hit rate and coverage for a mixed group", () => {
    const records = [
      usage({
        partID: "a",
        tokens: { input: 100, output: 0, reasoning: 0, cacheRead: 300, cacheWrite: 100 },
      }),
      usage({
        partID: "b",
        tokens: { input: 500, output: 0, reasoning: 0, cacheRead: 100, cacheWrite: 0 },
      }),
      usage({
        partID: "c",
        tokens: { input: 50, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    const [group] = computeGroupedMetrics(records, "day");
    expect(group.steps).toBe(3);
    expect(group.eligibleSteps).toBe(2);
    expect(group.coverage).toBeCloseTo(2 / 3, 10);
    // (300 + 100) / (300 + 100 + 100 + 500 + 50)
    expect(group.hitRate).toBeCloseTo(400 / 1150, 10);
  });

  test("returns null hit rate when no steps are cache eligible", () => {
    const records = [
      usage({
        partID: "a",
        tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    const [group] = computeGroupedMetrics(records, "day");
    expect(group.hitRate).toBeNull();
    expect(group.coverage).toBe(0);
  });

  test("groups by the selected key", () => {
    const records = [
      usage({ partID: "a", vvocVersion: "1.2.10" }),
      usage({ partID: "b", vvocVersion: "1.2.11" }),
      usage({ partID: "c", vvocVersion: "1.2.11", ts: "2026-08-18T10:00:00.000Z" }),
    ];
    const groups = computeGroupedMetrics(records, "vvoc");
    expect(groups.map((group) => group.key).sort()).toEqual(["1.2.10", "1.2.11"]);
    expect(groups.find((group) => group.key === "1.2.11")?.steps).toBe(2);
  });
});

describe("filterUsageRecords", () => {
  test("includes both since and until boundary dates", () => {
    const records = [
      usage({ partID: "before", ts: "2026-08-09T23:59:59.999Z" }),
      usage({ partID: "since-edge", ts: "2026-08-10T00:00:00.000Z" }),
      usage({ partID: "inside", ts: "2026-08-15T10:00:00.000Z" }),
      usage({ partID: "until-edge", ts: "2026-08-20T23:59:59.999Z" }),
      usage({ partID: "after", ts: "2026-08-21T00:00:00.000Z" }),
    ];
    const result = filterUsageRecords(records, { since: "2026-08-10", until: "2026-08-20" });
    expect(result.map((record) => record.partID)).toEqual(["since-edge", "inside", "until-edge"]);
  });

  test("matches project substrings case-insensitively", () => {
    const records = [
      usage({ partID: "a", projectDirectory: "/home/al/dev/VV-OpenCode" }),
      usage({ partID: "b", projectDirectory: "/home/al/dev/other" }),
    ];
    const result = filterUsageRecords(records, { project: "vv-opencode" });
    expect(result.map((record) => record.partID)).toEqual(["a"]);
  });
});

describe("parseSinceUntil", () => {
  const now = new Date("2026-08-19T12:00:00.000Z");

  test("returns undefined for undefined input", () => {
    expect(parseSinceUntil(undefined, now)).toBeUndefined();
  });

  test("resolves relative day, week, and month forms", () => {
    expect(parseSinceUntil("7d", now)).toBe("2026-08-12");
    expect(parseSinceUntil("2w", now)).toBe("2026-08-05");
    expect(parseSinceUntil("1m", now)).toBe("2026-07-20");
  });

  test("passes absolute dates through and rejects garbage", () => {
    expect(parseSinceUntil("2026-01-02", now)).toBe("2026-01-02");
    expect(parseSinceUntil("yesterday-ish", now)).toBeNull();
    expect(parseSinceUntil("", now)).toBeNull();
  });
});

describe("formatting", () => {
  test("formatTokenCount renders compact forms", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(2_100_000)).toBe("2.1M");
  });

  test("formatHitRate renders n/a or a percentage", () => {
    expect(formatHitRate(null)).toBe("n/a");
    expect(formatHitRate(0.8749)).toBe("87.5%");
  });
});
