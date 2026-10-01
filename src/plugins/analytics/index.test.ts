// FILE: src/plugins/analytics/index.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the native analytics plugin: per-family capture gating, native step attribution and usage/session record emission, missing-usage non-fabrication, fail-soft per-event handling, and cleanup.
//   SCOPE: Native event envelope handling, step.started attribution, step.ended token/cost normalization, session.created/renamed records, unknown/disabled policy, malformed tokens, transient append failure, and runtime release.
//   DEPENDS: [bun:test, src/plugins/analytics/index.ts, src/lib/analytics/types.ts, src/lib/package.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-PLUGIN-ANALYTICS, V-M-PLUGIN-ANALYTICS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   NativeEvent - Native event envelope with id, type, and data.
//   createEventQueue - Pushable native event stream fixture.
//   makeHarness - Builds the plugin with capturing deps and a fake runtime.
//   sessionCreated - Builds a native session.created event.
//   stepStarted - Builds a native session.step.started event.
//   stepEnded - Builds a native session.step.ended event.
//   compactionEvent - Builds a native session compaction event fixture.
//   stepFailed - Builds a native session.step.failed event fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-006 - Rewrote V1 event.properties.* tests against native event envelopes, step identity mapping, and per-family gating.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createAnalyticsPlugin } from "./index.js";
import { PACKAGE_VERSION } from "../../lib/package.js";
import { createDefaultVvocConfig, type VvocConfig } from "../../lib/vvoc-config.js";
import type { AnalyticsRecord, UsageRecord } from "../../lib/analytics/types.js";

interface NativeEvent {
  id?: string;
  type: string;
  data: Record<string, unknown>;
}

function createEventQueue() {
  const values: NativeEvent[] = [];
  const waiters: Array<(result: IteratorResult<NativeEvent>) => void> = [];
  let closed = false;
  const deliver = () => {
    while (values.length > 0 && waiters.length > 0) {
      waiters.shift()!({ done: false, value: values.shift()! });
    }
  };
  const next = (): Promise<IteratorResult<NativeEvent>> => {
    if (values.length > 0) return Promise.resolve({ done: false, value: values.shift()! });
    if (closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => waiters.push(resolve));
  };
  return {
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next,
          return: async () => ({ done: true as const, value: undefined }),
        };
      },
    },
    push(event: NativeEvent) {
      values.push(event);
      deliver();
    },
    async flush() {
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    close() {
      closed = true;
      while (waiters.length > 0) waiters.shift()!({ done: true, value: undefined });
    },
  };
}

async function makeHarness(
  options: {
    policy?: "enabled" | "disabled" | "unknown";
    append?: (record: AnalyticsRecord) => Promise<void>;
    resolve?: (sessionID: string) => { familyId: string; vvoc: VvocConfig } | undefined;
    configForThrows?: number;
  } = {},
) {
  const policy = options.policy ?? "enabled";
  const records: AnalyticsRecord[] = [];
  const queue = createEventQueue();
  let released = false;
  const config: VvocConfig = createDefaultVvocConfig();
  if (policy === "disabled") config.plugins = { ...config.plugins, analytics: false };
  const capture = { familyId: "fam-1", vvoc: config };
  let configForCalls = 0;
  const fakeRuntime = {
    snapshots: {
      configFor: async (sessionID: string) => {
        configForCalls += 1;
        if (options.configForThrows !== undefined && configForCalls <= options.configForThrows) {
          throw new Error("snapshot unavailable");
        }
        if (options.resolve !== undefined) return options.resolve(sessionID);
        return policy === "unknown" ? undefined : capture;
      },
      accept: async () => ({ status: "unbound" }),
    },
    release: async () => {
      released = true;
    },
  };
  const fakeContext = {
    location: {
      directory: "/home/al/dev/project",
      project: {
        id: "proj_1",
        directory: "/home/al/dev/project",
        canonical: "/home/al/dev/project",
      },
    },
    event: { subscribe: () => queue.stream },
  };
  const plugin = createAnalyticsPlugin({
    acquireRuntime: async () => fakeRuntime as never,
    append:
      options.append ??
      (async (record) => {
        records.push(record);
      }),
    now: () => new Date("2026-08-21T07:00:00.000Z"),
    log: () => undefined,
  });
  const cleanup = (await plugin.setup(fakeContext as never)) as () => Promise<void>;
  return {
    records,
    emit: async (event: NativeEvent) => {
      queue.push(event);
      await queue.flush();
    },
    cleanup,
    isReleased: () => released,
  };
}

function sessionCreated(
  sessionID = "ses_1",
  version = "2.0.18",
  title = "Session title",
): NativeEvent {
  return {
    id: "evt_created",
    type: "session.created",
    data: { sessionID, projectID: "proj_1", title, version },
  };
}

function stepStarted(
  sessionID = "ses_1",
  assistantMessageID = "msg_1",
  agent = "build",
  model: { providerID: string; id: string } = { providerID: "anthropic", id: "claude-sonnet-4-5" },
): NativeEvent {
  return {
    id: `evt_started_${assistantMessageID}`,
    type: "session.step.started",
    data: { sessionID, assistantMessageID, agent, model },
  };
}

function stepEnded(
  overrides: {
    id?: string;
    sessionID?: string;
    assistantMessageID?: string;
    tokens?: unknown;
    cost?: unknown;
  } = {},
): NativeEvent {
  const data: Record<string, unknown> = {
    sessionID: overrides.sessionID ?? "ses_1",
    assistantMessageID: overrides.assistantMessageID ?? "msg_1",
    finish: "stop",
    cost: overrides.cost ?? 0.02,
  };
  data.tokens = Object.hasOwn(overrides, "tokens")
    ? overrides.tokens
    : { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 100 } };
  return { id: overrides.id ?? "evt_ended", type: "session.step.ended", data };
}

function compactionEvent(
  type: "session.compaction.ended" | "session.compaction.failed",
  overrides: { id?: string; cost?: unknown; tokens?: unknown; model?: unknown } = {},
): NativeEvent {
  const data: Record<string, unknown> = {
    sessionID: "ses_1",
    reason: "auto",
    error: { message: "compaction failed" },
    model: overrides.model ?? { providerID: "deepseek", id: "deepseek-chat" },
  };
  data.tokens = Object.hasOwn(overrides, "tokens")
    ? overrides.tokens
    : { input: 40, output: 8, reasoning: 2, cache: { read: 10, write: 4 } };
  data.cost = overrides.cost ?? 0.05;
  return { id: overrides.id ?? "evt_compaction", type, data };
}

function stepFailed(
  overrides: {
    id?: string;
    sessionID?: string;
    assistantMessageID?: string;
    tokens?: unknown;
    cost?: unknown;
  } = {},
): NativeEvent {
  const data: Record<string, unknown> = {
    sessionID: overrides.sessionID ?? "ses_1",
    assistantMessageID: overrides.assistantMessageID ?? "msg_1",
    error: { message: "provider error" },
    cost: overrides.cost ?? 0.01,
  };
  data.tokens = Object.hasOwn(overrides, "tokens")
    ? overrides.tokens
    : { input: 7, output: 3, reasoning: 1, cache: { read: 2, write: 1 } };
  return { id: overrides.id ?? "evt_failed", type: "session.step.failed", data };
}

describe("AnalyticsPlugin", () => {
  test("native step events append one usage record and one session record with attribution", async () => {
    const harness = await makeHarness();
    await harness.emit(sessionCreated());
    await harness.emit(stepStarted());
    await harness.emit(stepEnded());

    const usage = harness.records.find((record) => record.kind === "usage") as UsageRecord;
    expect(usage).toBeDefined();
    expect(usage.projectDirectory).toBe("/home/al/dev/project");
    expect(usage.projectID).toBe("proj_1");
    expect(usage.vvocVersion).toBe(PACKAGE_VERSION);
    expect(usage.opencodeVersion).toBe("2.0.18");
    expect(usage.sessionID).toBe("ses_1");
    expect(usage.messageID).toBe("msg_1");
    // Stable native step-observation identity is the event envelope id.
    expect(usage.partID).toBe("evt_ended");
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

    const sessionRecords = harness.records.filter((record) => record.kind === "session");
    expect(sessionRecords.length).toBe(1);
    expect(sessionRecords[0]).toMatchObject({ sessionID: "ses_1", title: "Session title" });
  });

  test("a step ending before its start falls back to empty attribution and unknown version", async () => {
    const harness = await makeHarness();
    await harness.emit(stepEnded());
    const usage = harness.records.find((record) => record.kind === "usage") as UsageRecord;
    expect(usage.providerID).toBe("");
    expect(usage.modelID).toBe("");
    expect(usage.agent).toBe("");
    expect(usage.opencodeVersion).toBe("unknown");
  });

  test("session.created then session.renamed each append a session record with the latest title", async () => {
    const harness = await makeHarness();
    await harness.emit(sessionCreated("ses_a", "2.0.18", "First title"));
    await harness.emit({
      id: "evt_renamed",
      type: "session.renamed",
      data: { sessionID: "ses_a", title: "Renamed" },
    });

    const sessionRecords = harness.records.filter((record) => record.kind === "session");
    expect(sessionRecords).toHaveLength(2);
    expect(sessionRecords[0]).toMatchObject({ sessionID: "ses_a", title: "First title" });
    expect(sessionRecords[1]).toMatchObject({ sessionID: "ses_a", title: "Renamed" });
  });

  test("missing or malformed reported usage is not turned into a fabricated zero-token record", async () => {
    const harness = await makeHarness();
    await harness.emit(stepStarted());
    await harness.emit(stepEnded({ id: "evt_missing", tokens: undefined }));
    await harness.emit(
      stepEnded({ id: "evt_partial", tokens: { input: 10, output: 2, cache: { read: 1 } } }),
    );
    expect(harness.records.filter((record) => record.kind === "usage")).toHaveLength(0);
  });

  test("a reported zero-token step is still recorded", async () => {
    const harness = await makeHarness();
    await harness.emit(
      stepEnded({
        id: "evt_zero",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    const usage = harness.records.find((record) => record.kind === "usage") as UsageRecord;
    expect(usage.tokens).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("a failed native step with reported usage records one usage event with step attribution", async () => {
    const harness = await makeHarness();
    await harness.emit(stepStarted("ses_1", "msg_failed", "build"));
    await harness.emit(stepFailed({ id: "evt_step_failed", assistantMessageID: "msg_failed" }));
    const usage = harness.records.find((record) => record.kind === "usage") as UsageRecord;
    expect(usage).toBeDefined();
    expect(usage.partID).toBe("evt_step_failed");
    expect(usage.messageID).toBe("msg_failed");
    expect(usage.agent).toBe("build");
    expect(usage.providerID).toBe("anthropic");
    expect(usage.modelID).toBe("claude-sonnet-4-5");
    expect(usage.tokens).toEqual({
      input: 7,
      output: 3,
      reasoning: 1,
      cacheRead: 2,
      cacheWrite: 1,
    });
  });

  test("a completed compaction with reported usage records one usage event with the compaction model", async () => {
    const harness = await makeHarness();
    await harness.emit(compactionEvent("session.compaction.ended", { id: "evt_compaction_ok" }));
    const usage = harness.records.find((record) => record.kind === "usage") as UsageRecord;
    expect(usage).toBeDefined();
    expect(usage.partID).toBe("evt_compaction_ok");
    // Message identity mirrors the native projector (SessionMessage.ID.fromEvent).
    expect(usage.messageID).toBe("msg_compaction_ok");
    expect(usage.providerID).toBe("deepseek");
    expect(usage.modelID).toBe("deepseek-chat");
    expect(usage.agent).toBe("");
    expect(usage.tokens.input).toBe(40);
  });

  test("a failed compaction with reported usage records one usage event with unknown model", async () => {
    const harness = await makeHarness();
    await harness.emit({
      id: "evt_compaction_bad",
      type: "session.compaction.failed",
      data: {
        sessionID: "ses_1",
        reason: "auto",
        error: { message: "boom" },
        cost: 0.03,
        tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    const usage = harness.records.find((record) => record.kind === "usage") as UsageRecord;
    expect(usage).toBeDefined();
    expect(usage.partID).toBe("evt_compaction_bad");
    expect(usage.messageID).toBe("msg_compaction_bad");
    expect(usage.providerID).toBe("");
    expect(usage.modelID).toBe("");
    expect(usage.agent).toBe("");
    expect(usage.cost).toBe(0.03);
  });

  test("failed steps and compactions without reported usage produce no record", async () => {
    const harness = await makeHarness();
    await harness.emit(stepFailed({ id: "evt_step_no_usage", tokens: undefined }));
    await harness.emit(
      compactionEvent("session.compaction.failed", {
        id: "evt_compaction_no_usage",
        tokens: undefined,
      }),
    );
    expect(harness.records.filter((record) => record.kind === "usage")).toEqual([]);
  });

  test("internal usage.recorded and aggregate usage.updated events are never double counted", async () => {
    const harness = await makeHarness();
    await harness.emit({
      id: "evt_usage_recorded",
      type: "session.usage.recorded",
      data: {
        sessionID: "ses_1",
        source: "compaction",
        cost: 0.1,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    await harness.emit({
      id: "evt_usage_updated",
      type: "session.usage.updated",
      data: {
        sessionID: "ses_1",
        cost: 0.2,
        tokens: { input: 2, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    });
    expect(harness.records.filter((record) => record.kind === "usage")).toEqual([]);
  });

  test("a transient append failure is contained and later events still record", async () => {
    let calls = 0;
    const captured: AnalyticsRecord[] = [];
    const harness = await makeHarness({
      append: async (record) => {
        calls += 1;
        if (calls === 1) throw new Error("disk full");
        captured.push(record);
      },
    });
    await harness.emit(stepStarted());
    await harness.emit(stepEnded({ id: "evt_first" }));
    await harness.emit(stepEnded({ id: "evt_second" }));
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(captured.filter((record) => record.kind === "usage")).toHaveLength(1);
  });

  test("a disabled captured family records nothing", async () => {
    const harness = await makeHarness({ policy: "disabled" });
    await harness.emit(sessionCreated());
    await harness.emit(stepStarted());
    await harness.emit(stepEnded());
    expect(harness.records).toEqual([]);
  });

  test("an unknown captured policy records nothing", async () => {
    const harness = await makeHarness({ policy: "unknown" });
    await harness.emit(stepStarted());
    await harness.emit(stepEnded());
    expect(harness.records).toEqual([]);
  });

  test("mixed captured families record only the enabled family", async () => {
    const enabled = createDefaultVvocConfig();
    const disabled = createDefaultVvocConfig();
    disabled.plugins = { ...disabled.plugins, analytics: false };
    const harness = await makeHarness({
      resolve: (sessionID) =>
        sessionID === "ses_a"
          ? { familyId: "fam-a", vvoc: enabled }
          : { familyId: "fam-b", vvoc: disabled },
    });
    await harness.emit(stepStarted("ses_a", "msg_a"));
    await harness.emit(stepEnded({ id: "evt_a", sessionID: "ses_a", assistantMessageID: "msg_a" }));
    await harness.emit(stepStarted("ses_b", "msg_b"));
    await harness.emit(stepEnded({ id: "evt_b", sessionID: "ses_b", assistantMessageID: "msg_b" }));

    const usage = harness.records.filter((record) => record.kind === "usage") as UsageRecord[];
    expect(usage).toHaveLength(1);
    expect(usage[0]!.sessionID).toBe("ses_a");
  });

  test("interleaved primary and child steps keep distinct attribution and reported usage", async () => {
    const harness = await makeHarness();
    await harness.emit(
      stepStarted("ses_parent", "msg_parent", "build", {
        providerID: "anthropic",
        id: "claude-opus",
      }),
    );
    await harness.emit(
      stepStarted("ses_child", "msg_child", "vv-implementer", {
        providerID: "deepseek",
        id: "deepseek-chat",
      }),
    );
    await harness.emit(
      stepEnded({
        id: "evt_parent",
        sessionID: "ses_parent",
        assistantMessageID: "msg_parent",
        tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    await harness.emit(
      stepEnded({
        id: "evt_child",
        sessionID: "ses_child",
        assistantMessageID: "msg_child",
        tokens: { input: 20, output: 2, reasoning: 1, cache: { read: 5, write: 3 } },
      }),
    );

    const usage = harness.records.filter((record) => record.kind === "usage") as UsageRecord[];
    expect(usage).toHaveLength(2);
    const parent = usage.find((record) => record.sessionID === "ses_parent")!;
    const child = usage.find((record) => record.sessionID === "ses_child")!;
    expect(parent.agent).toBe("build");
    expect(parent.providerID).toBe("anthropic");
    expect(parent.modelID).toBe("claude-opus");
    expect(parent.tokens.input).toBe(10);
    expect(child.agent).toBe("vv-implementer");
    expect(child.providerID).toBe("deepseek");
    expect(child.tokens.input).toBe(20);
    expect(child.tokens.cacheRead).toBe(5);
  });

  test("a transient snapshot acquisition failure does not prevent later events from recording", async () => {
    const harness = await makeHarness({ configForThrows: 1 });
    await harness.emit(stepStarted());
    await harness.emit(stepEnded({ id: "evt_first" }));
    await harness.emit(stepEnded({ id: "evt_second" }));
    const usage = harness.records.filter((record) => record.kind === "usage");
    expect(usage.length).toBeGreaterThanOrEqual(1);
    expect((usage[usage.length - 1] as UsageRecord).partID).toBe("evt_second");
  });

  test("cleanup releases the shared runtime", async () => {
    const harness = await makeHarness();
    expect(harness.isReleased()).toBe(false);
    await harness.cleanup();
    expect(harness.isReleased()).toBe(true);
  });
});
