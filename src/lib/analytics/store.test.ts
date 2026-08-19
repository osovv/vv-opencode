// FILE: src/lib/analytics/store.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify analytics store directory resolution, monthly rotation, append-only writes, and tolerant reads.
//   SCOPE: File naming, cross-month placement, missing-directory reads, unparsable line skipping, ordering, and unrelated-file exclusion.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/analytics/store.ts, src/lib/analytics/types.ts]
//   LINKS: [M-ANALYTICS-STORE, V-M-ANALYTICS-STORE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   makeRecord - Builds a minimal usage record for store tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-19-cache-hit-rate-analytics - Added store coverage for rotation, tolerance, and ordering.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAnalyticsRecord,
  getAnalyticsDir,
  readAnalyticsRecords,
  resolveAnalyticsFileName,
} from "./store.js";
import type { UsageRecord } from "./types.js";

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    kind: "usage",
    ts: "2026-08-19T10:00:00.000Z",
    projectID: "p1",
    projectDirectory: "/tmp/project",
    sessionID: "ses_1",
    messageID: "msg_1",
    partID: `prt_${Math.random().toString(36).slice(2)}`,
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
    agent: "build",
    tokens: { input: 100, output: 10, reasoning: 0, cacheRead: 900, cacheWrite: 50 },
    cost: 0.01,
    vvocVersion: "1.2.11",
    opencodeVersion: "1.18.2",
    ...overrides,
  };
}

describe("resolveAnalyticsFileName", () => {
  test("derives the monthly file name from the record timestamp", () => {
    expect(resolveAnalyticsFileName("2026-08-19T10:00:00.000Z")).toBe("usage-2026-08.jsonl");
    expect(resolveAnalyticsFileName("2026-01-01T00:00:00.000Z")).toBe("usage-2026-01.jsonl");
  });
});

describe("appendAnalyticsRecord", () => {
  test("creates the analytics directory and writes one JSON line per call", async () => {
    const dataHome = await mkdtemp(join(tmpdir(), "vvoc-analytics-store-"));
    try {
      await appendAnalyticsRecord(makeRecord(), { dataHomeOverride: dataHome });
      await appendAnalyticsRecord(makeRecord(), { dataHomeOverride: dataHome });

      const dir = getAnalyticsDir(dataHome);
      const text = await readFile(join(dir, "usage-2026-08.jsonl"), "utf8");
      const lines = text.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).kind).toBe("usage");
      expect(JSON.parse(lines[1]).kind).toBe("usage");
    } finally {
      await rm(dataHome, { recursive: true, force: true });
    }
  });

  test("routes records from different months into separate monthly files", async () => {
    const dataHome = await mkdtemp(join(tmpdir(), "vvoc-analytics-store-"));
    try {
      await appendAnalyticsRecord(makeRecord({ ts: "2026-07-31T23:59:59.999Z" }), {
        dataHomeOverride: dataHome,
      });
      await appendAnalyticsRecord(makeRecord({ ts: "2026-08-01T00:00:00.000Z" }), {
        dataHomeOverride: dataHome,
      });

      const files = (await readdir(getAnalyticsDir(dataHome))).sort();
      expect(files).toEqual(["usage-2026-07.jsonl", "usage-2026-08.jsonl"]);
    } finally {
      await rm(dataHome, { recursive: true, force: true });
    }
  });
});

describe("readAnalyticsRecords", () => {
  test("returns an empty array when the analytics directory does not exist", async () => {
    const dataHome = await mkdtemp(join(tmpdir(), "vvoc-analytics-store-"));
    try {
      expect(await readAnalyticsRecords({ dataHomeOverride: dataHome })).toEqual([]);
    } finally {
      await rm(dataHome, { recursive: true, force: true });
    }
  });

  test("skips empty and unparsable lines without throwing", async () => {
    const dataHome = await mkdtemp(join(tmpdir(), "vvoc-analytics-store-"));
    try {
      const dir = getAnalyticsDir(dataHome);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "usage-2026-08.jsonl"),
        `${JSON.stringify(makeRecord())}\n\nnot-json{{{}}\n   \n`,
        "utf8",
      );

      const records = await readAnalyticsRecords({ dataHomeOverride: dataHome });
      expect(records).toHaveLength(1);
      expect(records[0].kind).toBe("usage");
    } finally {
      await rm(dataHome, { recursive: true, force: true });
    }
  });

  test("returns records ordered by file name then line order and ignores unrelated files", async () => {
    const dataHome = await mkdtemp(join(tmpdir(), "vvoc-analytics-store-"));
    try {
      await appendAnalyticsRecord(makeRecord({ partID: "p_jul", ts: "2026-07-15T10:00:00.000Z" }), {
        dataHomeOverride: dataHome,
      });
      await appendAnalyticsRecord(
        makeRecord({ partID: "p_aug_1", ts: "2026-08-15T10:00:00.000Z" }),
        { dataHomeOverride: dataHome },
      );
      await appendAnalyticsRecord(
        makeRecord({ partID: "p_aug_2", ts: "2026-08-16T10:00:00.000Z" }),
        { dataHomeOverride: dataHome },
      );
      const dir = getAnalyticsDir(dataHome);
      await writeFile(join(dir, "notes.txt"), "ignore me", "utf8");
      await writeFile(join(dir, "usage-broken.jsonl"), "ignore me too", "utf8");

      const usage = await readAnalyticsRecords({ dataHomeOverride: dataHome });
      expect(usage).toHaveLength(3);
      expect((usage[0] as UsageRecord).partID).toBe("p_jul");
      expect((usage[1] as UsageRecord).partID).toBe("p_aug_1");
      expect((usage[2] as UsageRecord).partID).toBe("p_aug_2");
    } finally {
      await rm(dataHome, { recursive: true, force: true });
    }
  });
});
