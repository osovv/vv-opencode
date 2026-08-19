// FILE: src/plugins/analytics/index.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify analytics plugin toggle gating, attribution, usage/session record emission, and fail-soft behavior.
//   SCOPE: Disabled toggle no-op, message attribution mapping, step-finish normalization, session version attribution, non-step parts, and swallowed append failures.
//   DEPENDS: [bun:test, @opencode-ai/plugin, @opencode-ai/sdk, src/plugins/analytics/index.ts, src/lib/analytics/types.ts]
//   LINKS: [M-PLUGIN-ANALYTICS, V-M-PLUGIN-ANALYTICS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   makePlugin - Builds the plugin with capturing deps and forced enablement.
//   emit - Invokes the plugin event hook with a cast event.
//   stepFinishPart - Builds a step-finish part payload.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-19-cache-hit-rate-analytics - Added plugin coverage for gating, attribution, and fail-soft collection.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode-ai/plugin";
import type { Event, Part } from "@opencode-ai/sdk";
import { createAnalyticsPlugin } from "./index.js";
import { PACKAGE_VERSION } from "../../lib/package.js";
import type { AnalyticsRecord, UsageRecord } from "../../lib/analytics/types.js";

function stepFinishPart(overrides: Record<string, unknown> = {}): Part {
  return {
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "step-finish",
    reason: "stop",
    cost: 0.02,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 100 } },
    ...overrides,
  } as unknown as Part;
}

async function makePlugin(
  options: {
    enabled?: boolean;
    records?: AnalyticsRecord[];
  } = {},
) {
  const records: AnalyticsRecord[] = options.records ?? [];
  const plugin: Plugin = createAnalyticsPlugin({
    enabled: async () => options.enabled ?? true,
    append: async (record) => {
      records.push(record);
    },
  });
  const hooks = await plugin({
    directory: "/home/al/dev/project",
    project: { id: "proj_1" },
  } as unknown as Parameters<Plugin>[0]);
  const emit = async (event: unknown) => {
    if (!hooks.event) throw new Error("plugin has no event hook");
    await hooks.event({ event: event as Event });
  };
  return { records, emit, hooks };
}

describe("AnalyticsPlugin", () => {
  test("disabled toggle returns no event hook and records nothing", async () => {
    const { records, hooks } = await makePlugin({ enabled: false });
    expect(hooks.event).toBeUndefined();
    expect(records).toEqual([]);
  });

  test("step-finish part appends exactly one normalized usage record", async () => {
    const { records, emit } = await makePlugin();
    await emit({
      type: "session.created",
      properties: { info: sessionInfo({ id: "ses_1", version: "1.18.18" }) },
    });
    await emit({
      type: "message.updated",
      properties: {
        info: {
          id: "msg_1",
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          agent: "build",
        },
      },
    });
    await emit({
      type: "message.part.updated",
      properties: { part: stepFinishPart() },
    });

    expect(records).toHaveLength(2);
    const usage = records.find((record) => record.kind === "usage") as UsageRecord;
    expect(usage.projectDirectory).toBe("/home/al/dev/project");
    expect(usage.projectID).toBe("proj_1");
    expect(usage.vvocVersion).toBe(PACKAGE_VERSION);
    expect(usage.opencodeVersion).toBe("1.18.18");
    expect(usage.tokens).toEqual({
      input: 100,
      output: 20,
      reasoning: 5,
      cacheRead: 900,
      cacheWrite: 100,
    });
    expect(usage.cost).toBe(0.02);
    expect(usage.agent).toBe("build");
    expect(usage.providerID).toBe("anthropic");
    expect(usage.modelID).toBe("claude-sonnet-4-5");
  });

  test("part arriving before its message falls back to empty attribution and unknown version", async () => {
    const { records, emit } = await makePlugin();
    await emit({
      type: "message.part.updated",
      properties: { part: stepFinishPart() },
    });
    const usage = records[0] as UsageRecord;
    expect(usage.providerID).toBe("");
    expect(usage.modelID).toBe("");
    expect(usage.agent).toBe("");
    expect(usage.opencodeVersion).toBe("unknown");
  });

  test("non-step-finish parts append nothing", async () => {
    const { records, emit } = await makePlugin();
    await emit({
      type: "message.part.updated",
      properties: { part: { id: "prt_x", type: "text", text: "hi" } },
    });
    expect(records).toEqual([]);
  });

  test("session.created and session.updated each append one session record with the title", async () => {
    const { records, emit } = await makePlugin();
    await emit({
      type: "session.created",
      properties: { info: sessionInfo({ id: "ses_a", title: "First title" }) },
    });
    await emit({
      type: "session.updated",
      properties: { info: sessionInfo({ id: "ses_a", title: "Renamed" }) },
    });

    const sessionRecords = records.filter((record) => record.kind === "session");
    expect(sessionRecords).toHaveLength(2);
    expect(sessionRecords[0]).toMatchObject({ sessionID: "ses_a", title: "First title" });
    expect(sessionRecords[1]).toMatchObject({ sessionID: "ses_a", title: "Renamed" });
  });

  test("malformed token payloads normalize to zero counts instead of NaN", async () => {
    const { records, emit } = await makePlugin();
    await emit({
      type: "message.part.updated",
      properties: {
        part: stepFinishPart({ tokens: undefined, cost: undefined }),
      },
    });
    const usage = records[0] as UsageRecord;
    expect(usage.tokens).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(usage.cost).toBe(0);
  });

  test("an append failure is swallowed and does not propagate", async () => {
    let calls = 0;
    const plugin: Plugin = createAnalyticsPlugin({
      enabled: async () => true,
      append: async () => {
        calls += 1;
        throw new Error("disk full");
      },
    });
    const hooks = await plugin({
      directory: "/home/al/dev/project",
      project: { id: "proj_1" },
    } as unknown as Parameters<Plugin>[0]);
    await expect(
      hooks.event!({
        event: {
          type: "message.part.updated",
          properties: { part: stepFinishPart() },
        } as unknown as Event,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });
});

function sessionInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ses_1",
    projectID: "proj_1",
    directory: "/home/al/dev/project",
    title: "Session title",
    version: "1.18.18",
    time: { created: 1_772_735_091_353, updated: 1_772_735_091_353 },
    ...overrides,
  };
}
