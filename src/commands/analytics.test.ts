// FILE: src/commands/analytics.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify analytics cache-hit-rate command helpers and end-to-end command behavior against fixture JSONL stores.
//   SCOPE: Ordering rules, row building with session titles, table rendering, flag validation, JSON output, empty state, and env-directed store reads.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/commands/analytics.ts, src/lib/analytics/store.ts, src/lib/analytics/types.ts]
//   LINKS: [M-CLI-ANALYTICS, V-M-CLI-ANALYTICS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   usage - Builds a usage record fixture.
//   runCommand - Invokes the cache-hit-rate command with captured output.
//   withStore - Seeds an isolated data home with records and runs a callback.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-19-cache-hit-rate-analytics - Added CLI coverage for rendering, flags, JSON, and empty state.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCacheHitRateRows,
  cacheHitRateCommand,
  orderGroups,
  renderCacheHitRateTable,
  sessionDisplayLabel,
} from "./analytics.js";
import { appendAnalyticsRecord } from "../lib/analytics/store.js";
import type { GroupedMetrics, UsageRecord } from "../lib/analytics/types.js";

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    kind: "usage",
    ts: "2026-08-19T10:00:00.000Z",
    projectID: "p1",
    projectDirectory: "/home/al/dev/project",
    sessionID: "ses_11111111",
    messageID: "msg_1",
    partID: "prt_1",
    providerID: "anthropic",
    modelID: "claude-sonnet-4-5",
    agent: "build",
    tokens: { input: 100, output: 10, reasoning: 0, cacheRead: 900, cacheWrite: 100 },
    cost: 0.01,
    vvocVersion: "1.2.11",
    opencodeVersion: "1.18.18",
    ...overrides,
  };
}

function group(overrides: Partial<GroupedMetrics> = {}): GroupedMetrics {
  return {
    key: "2026-08-19",
    steps: 10,
    eligibleSteps: 9,
    coverage: 0.9,
    hitRate: 0.85,
    cacheRead: 900_000,
    cacheWrite: 100_000,
    input: 60_000,
    output: 20_000,
    reasoning: 5_000,
    ...overrides,
  };
}

describe("orderGroups", () => {
  test("date order sorts group keys descending", () => {
    const ordered = orderGroups(
      [group({ key: "2026-08-01" }), group({ key: "2026-08-19" }), group({ key: "2026-08-05" })],
      "date",
    );
    expect(ordered.map((entry) => entry.key)).toEqual(["2026-08-19", "2026-08-05", "2026-08-01"]);
  });

  test("steps order sorts descending by steps", () => {
    const ordered = orderGroups(
      [group({ key: "a", steps: 2 }), group({ key: "b", steps: 9 })],
      "steps",
    );
    expect(ordered.map((entry) => entry.key)).toEqual(["b", "a"]);
  });

  test("hit-rate order sorts descending with null rates last", () => {
    const ordered = orderGroups(
      [
        group({ key: "null", hitRate: null }),
        group({ key: "low", hitRate: 0.4 }),
        group({ key: "high", hitRate: 0.95 }),
      ],
      "hit-rate",
    );
    expect(ordered.map((entry) => entry.key)).toEqual(["high", "low", "null"]);
  });
});

describe("buildCacheHitRateRows", () => {
  test("labels session groups with the latest known title and short id", () => {
    const titles = new Map([["ses_11111111", "Fix cache bug"]]);
    const rows = buildCacheHitRateRows([group({ key: "ses_11111111" })], "session", titles);
    expect(rows[0].group).toBe("Fix cache bug ses_1111");
  });

  test("falls back to the short session id without a title", () => {
    expect(sessionDisplayLabel("ses_11111111", new Map())).toBe("ses_1111");
  });

  test("keeps non-session keys verbatim and preserves metric fields", () => {
    const rows = buildCacheHitRateRows([group({ key: "1.2.11" })], "vvoc", new Map());
    expect(rows[0]).toMatchObject({
      group: "1.2.11",
      steps: 10,
      eligibleSteps: 9,
      coverage: 0.9,
      hitRate: 0.85,
      cacheRead: 900_000,
      cacheWrite: 100_000,
      input: 60_000,
    });
  });
});

describe("renderCacheHitRateTable", () => {
  test("renders the documented header and formatted cells", () => {
    const table = renderCacheHitRateTable(
      buildCacheHitRateRows(
        [
          group({ key: "2026-08-19" }),
          group({ key: "2026-08-20", hitRate: null, eligibleSteps: 0, coverage: 0 }),
        ],
        "day",
        new Map(),
      ),
    );
    const lines = table.split("\n");
    expect(lines[0]).toContain("GROUP");
    expect(lines[0]).toContain("STEPS");
    expect(lines[0]).toContain("COVERAGE");
    expect(lines[0]).toContain("HIT-RATE");
    expect(lines[0]).toContain("CACHE-READ");
    expect(lines[0]).toContain("CACHE-WRITE");
    expect(lines[0]).toContain("FRESH-IN");
    expect(lines[1]).toContain("85.0%");
    expect(lines[1]).toContain("900.0k");
    expect(lines[1]).toContain("60.0k");
    expect(lines[2]).toContain("n/a");
  });
});

async function runCommand(
  args: Record<string, unknown>,
): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  console.log = (line: string) => {
    stdout.push(line);
  };
  console.error = (line: string) => {
    stderr.push(line);
  };
  try {
    await cacheHitRateCommand.run!({
      args: args as never,
      ctx: {} as never,
      cmd: cacheHitRateCommand,
      rawArgs: [] as never,
      options: {} as never,
      subCommand: undefined as never,
    } as never);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
  return { stdout, stderr };
}

async function withStore(
  records: Parameters<typeof appendAnalyticsRecord>[0][],
  callback: () => Promise<void>,
): Promise<void> {
  const dataHome = await mkdtemp(join(tmpdir(), "vvoc-analytics-cli-"));
  const previous = process.env.VVOC_ANALYTICS_DATA_HOME;
  process.env.VVOC_ANALYTICS_DATA_HOME = dataHome;
  try {
    for (const record of records) {
      await appendAnalyticsRecord(record, { dataHomeOverride: dataHome });
    }
    await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.VVOC_ANALYTICS_DATA_HOME;
    } else {
      process.env.VVOC_ANALYTICS_DATA_HOME = previous;
    }
    await rm(dataHome, { recursive: true, force: true });
  }
}

describe("cacheHitRateCommand", () => {
  test("prints a table grouped by vvoc version from the fixture store", async () => {
    await withStore(
      [
        usage({ partID: "a", vvocVersion: "1.2.10" }),
        usage({ partID: "b", vvocVersion: "1.2.11" }),
        usage({ partID: "c", vvocVersion: "1.2.11" }),
      ],
      async () => {
        const { stdout } = await runCommand({ "group-by": "vvoc" });
        const output = stdout.join("\n");
        expect(output).toContain("GROUP");
        expect(output).toContain("1.2.10");
        expect(output).toContain("1.2.11");
      },
    );
  });

  test("prints machine-readable JSON with --json", async () => {
    await withStore(
      [usage({ partID: "a" }), usage({ partID: "b", ts: "2026-08-18T10:00:00.000Z" })],
      async () => {
        const { stdout } = await runCommand({ "group-by": "day", json: true });
        const rows = JSON.parse(stdout.join("\n")) as Array<{
          group: string;
          hitRate: number | null;
        }>;
        expect(Array.isArray(rows)).toBe(true);
        expect(rows).toHaveLength(2);
        expect(rows[0].group).toBe("2026-08-19");
      },
    );
  });

  test("prints the friendly empty state and exits 0 when nothing matches", async () => {
    await withStore([usage({ partID: "a" })], async () => {
      const { stdout } = await runCommand({ since: "2020-01-01", until: "2020-01-02" });
      expect(stdout[0]).toBe("No analytics records matched the given filters.");
      expect(process.exitCode === 0 || process.exitCode === undefined).toBe(true);
    });
  });

  test("rejects an invalid --group-by naming the flag", async () => {
    const { stderr } = await runCommand({ "group-by": "bogus" });
    expect(stderr[0]).toContain("--group-by");
    expect(process.exitCode).toBe(1);
  });

  test("rejects an invalid --since naming the flag", async () => {
    const { stderr } = await runCommand({ since: "yesterday!" });
    expect(stderr[0]).toContain("--since");
    expect(process.exitCode).toBe(1);
  });

  test("respects --limit by truncating rendered rows", async () => {
    await withStore(
      [
        usage({ partID: "d1", ts: "2026-08-17T10:00:00.000Z" }),
        usage({ partID: "d2", ts: "2026-08-18T10:00:00.000Z" }),
        usage({ partID: "d3", ts: "2026-08-19T10:00:00.000Z" }),
      ],
      async () => {
        const { stdout } = await runCommand({ "group-by": "day", limit: 2, json: true });
        const rows = JSON.parse(stdout.join("\n")) as unknown[];
        expect(rows).toHaveLength(2);
      },
    );
  });
});
