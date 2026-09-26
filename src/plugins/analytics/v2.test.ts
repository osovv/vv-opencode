// FILE: src/plugins/analytics/v2.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the v2 analytics port: per-location gating, usage and session records, agent attribution tracking, and fail-soft behavior.
//   SCOPE: Unit tests for setupAnalyticsV2 with a mocked adapter, captured records, and a hand-driven event iterator.
//   DEPENDS: [src/plugins/analytics/v2.ts, src/plugins/v2-runtime/setup.ts]
//   LINKS: [V-M-PLUGIN-ANALYTICS, M-PLUGIN-ANALYTICS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   EventStream - Handle shape exposing push and end for driving the mocked event iterator.
//   configWithPlugin - Builds a default config with the analytics toggle set to a boolean.
//   makeAdapter - Builds a mocked adapter with a controllable event stream and per-directory enablement.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-003 - Added the v2 analytics port test suite.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { setupAnalyticsV2 } from "./v2.js";
import type { V2AdapterContext } from "../v2-runtime/setup.js";
import { createDefaultVvocConfig } from "../../lib/vvoc-config.js";
import type { AnalyticsRecord } from "../../lib/analytics/types.js";

function configWithPlugin(enabled: boolean) {
  const config = createDefaultVvocConfig();
  const plugins = config.plugins as Record<string, unknown>;
  plugins.analytics = enabled;
  return config;
}

interface EventStream {
  push(event: unknown): void;
  end(): void;
}

function makeAdapter(options?: { enabled?: boolean }): {
  adapter: V2AdapterContext;
  records: AnalyticsRecord[];
  stream: EventStream;
} {
  const records: AnalyticsRecord[] = [];
  const queue: Array<Record<string, unknown>> = [];
  const pending: Array<() => void> = [];
  const enabled = options?.enabled ?? true;

  const stream: EventStream = {
    push(event) {
      queue.push(event as Record<string, unknown>);
      for (const resolve of pending.splice(0)) resolve();
    },
    end() {
      for (const resolve of pending.splice(0)) resolve();
    },
  };

  const config = configWithPlugin(enabled);

  const adapter = {
    ctx: {
      app: { version: "2.0.18-test" },
      event: {
        subscribe: async function* () {
          while (true) {
            while (queue.length > 0) {
              yield queue.shift() as never;
            }
            await new Promise<void>((resolve) => pending.push(resolve));
          }
        },
      },
    },
    resolver: {
      forDirectory: async () => ({
        directory: "/tmp/proj-a",
        config,
        source: { kind: "project", path: "/tmp/proj-a/.vvoc/vvoc.json" },
        warnings: [],
        loadedAt: 0,
      }),
      forSession: async () => undefined,
      invalidate: () => {},
      cachedDirectories: [],
    },
    watchConfig: async () => () => {},
  } as unknown as V2AdapterContext;

  return { adapter, records, stream };
}

describe("setupAnalyticsV2", () => {
  test("records usage from session.step.ended with location-scoped gating enabled", async () => {
    const { adapter, records, stream } = makeAdapter();
    const cleanup = await setupAnalyticsV2(adapter, {
      append: async (record) => {
        records.push(record);
      },
      vvocVersion: "9.9.9-test",
    });
    expect(typeof cleanup).toBe("function");

    stream.push({
      type: "session.agent.selected",
      location: { directory: "/tmp/proj-a" },
      data: { sessionID: "s-1", agent: "build" },
    });
    stream.push({
      type: "session.step.ended",
      location: { directory: "/tmp/proj-a" },
      data: {
        sessionID: "s-1",
        assistantMessageID: "m-1",
        cost: 0.5,
        tokens: { input: 100, output: 20, reasoning: 3, cache: { read: 40, write: 10 } },
      },
    });
    stream.push({
      type: "session.created",
      location: { directory: "/tmp/proj-a" },
      data: { sessionID: "s-2" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(records.length).toBe(2);
    const usage = records.find((record) => record.kind === "usage");
    expect(usage).toBeDefined();
    if (usage?.kind === "usage") {
      expect(usage.sessionID).toBe("s-1");
      expect(usage.agent).toBe("build");
      expect(usage.tokens.input).toBe(100);
      expect(usage.tokens.cacheRead).toBe(40);
      expect(usage.cost).toBe(0.5);
      expect(usage.vvocVersion).toBe("9.9.9-test");
      expect(usage.opencodeVersion).toBe("2.0.18-test");
    }
    const session = records.find((record) => record.kind === "session");
    expect(session).toBeDefined();

    await cleanup?.();
  });

  test("drops events whose location has analytics disabled", async () => {
    const { adapter, records, stream } = makeAdapter({ enabled: false });
    const cleanup = await setupAnalyticsV2(adapter, {
      append: async (record) => {
        records.push(record);
      },
    });

    stream.push({
      type: "session.step.ended",
      location: { directory: "/tmp/proj-a" },
      data: {
        sessionID: "s-1",
        cost: 1,
        tokens: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(records).toEqual([]);
    await cleanup?.();
  });

  test("drops events without a location directory", async () => {
    const { adapter, records, stream } = makeAdapter();
    const cleanup = await setupAnalyticsV2(adapter, {
      append: async (record) => {
        records.push(record);
      },
    });

    stream.push({ type: "session.step.ended", data: { sessionID: "s-9" } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(records).toEqual([]);
    await cleanup?.();
  });
});
