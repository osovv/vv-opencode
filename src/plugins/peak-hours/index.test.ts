// FILE: src/plugins/peak-hours/index.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify peak-hours plugin gating, hard blocks, grace, exemptions, suggestions, soft pass-through, and fail-open behavior.
//   SCOPE: Disabled entry no-hook behavior, soft pass-through without server-side message mutation, hard blocking text with dynamic suggestions and all-peak degradation, session-age and parentID grace, internal and subagent-like exemptions, per-provider mode overrides, and lookup-failure fail-open.
//   DEPENDS: [bun:test, @opencode-ai/plugin, src/plugins/peak-hours/index.ts, src/lib/peak-hours.ts]
//   LINKS: [M-PLUGIN-PEAK-HOURS, V-M-PLUGIN-PEAK-HOURS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   NOW - Fixed Friday 07:00 UTC evaluation instant used by default fixtures.
//   deepseekSchedules - Schedule fixture with the deepseek peak windows active at NOW.
//   baseEntry - Fully seeded entry fixture for dependency injection.
//   makeDeps - Builds injectable dependencies with captured logs.
//   makePlugin - Builds the plugin hooks with the given dependency overrides.
//   makeParamsIO - Builds chat.params input and output for one LLM request.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Replaced soft system-note coverage with soft pass-through and chat.params no-op coverage after removing the chat.message injection.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode-ai/plugin";
import {
  buildHardBlockMessage,
  createPeakHoursPlugin,
  type PeakHoursPluginDependencies,
} from "./index.js";
import type { PeakHoursEntryConfig, PeakSchedules } from "../../lib/peak-hours.js";

// Friday 2026-08-21T07:00:00Z: inside the deepseek 06:00-10:00 UTC window.
const NOW = new Date("2026-08-21T07:00:00.000Z");

const deepseekSchedules: PeakSchedules = {
  deepseek: {
    windows: [
      { start: "01:00", end: "04:00", tz: "UTC" },
      { start: "06:00", end: "10:00", tz: "UTC" },
    ],
  },
};

function baseEntry(overrides: Partial<PeakHoursEntryConfig> = {}): PeakHoursEntryConfig {
  return {
    enabled: true,
    mode: "hard",
    graceActiveSessions: true,
    schedules: deepseekSchedules,
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<PeakHoursPluginDependencies> & { entry?: PeakHoursEntryConfig } = {},
) {
  const logs: Array<{ level: string; message: string; extra?: Record<string, unknown> }> = [];
  const deps: PeakHoursPluginDependencies = {
    now: () => NOW,
    loadEntry: async () => ({ entry: overrides.entry ?? baseEntry(), warnings: [] }),
    session: async () => ({ createdMs: NOW.getTime(), parentID: undefined }),
    connectedProviders: async () => ["deepseek", "z-ai", "qwen", "openai"],
    log: async (level, message, extra) => {
      logs.push({ level, message, extra });
    },
  };
  return { deps, logs, overrides };
}

async function makePlugin(
  overrides: Partial<PeakHoursPluginDependencies> & { entry?: PeakHoursEntryConfig } = {},
) {
  const { deps, logs } = makeDeps(overrides);
  const merged: PeakHoursPluginDependencies = { ...deps, ...overrides };
  const plugin = await createPeakHoursPlugin(merged)({ directory: "/project" } as never);
  return { plugin: plugin as Awaited<ReturnType<Plugin>>, logs };
}

/** chat.params-shaped input for the hard-block hook. */
function makeParamsIO(options: { agent?: string; providerID?: string; sessionID?: string } = {}) {
  const input = {
    sessionID: options.sessionID ?? "ses_1",
    agent: options.agent ?? "build",
    model: options.providerID
      ? { providerID: options.providerID, modelID: "some-model" }
      : undefined,
    provider: { info: { id: options.providerID ?? "provider" }, options: {}, source: "config" },
    message: { id: "msg_1", role: "user", agent: options.agent ?? "build" },
  };
  const output = { temperature: 0, topP: 0, topK: 0, maxOutputTokens: undefined, options: {} };
  return { input, output };
}

describe("PeakHoursPlugin gating", () => {
  test("registers no hooks when the entry is disabled", async () => {
    const { plugin } = await makePlugin({ entry: baseEntry({ enabled: false }) });
    expect(plugin["chat.message"]).toBeUndefined();
    expect(plugin["chat.params"]).toBeUndefined();
    expect(plugin.config).toBeUndefined();
  });

  test("registers the chat.params and config hooks when enabled", async () => {
    const { plugin } = await makePlugin();
    expect(plugin["chat.message"]).toBeUndefined();
    expect(typeof plugin["chat.params"]).toBe("function");
    expect(typeof plugin.config).toBe("function");
  });
});

describe("PeakHoursPlugin hard mode", () => {
  test("blocks a non-grace LLM request in chat.params with dynamic off-peak suggestions", async () => {
    const { plugin, logs } = await makePlugin();
    const { input, output } = makeParamsIO({ providerID: "deepseek" });

    await expect(plugin["chat.params"]!(input as never, output as never)).rejects.toThrow(
      /PEAK_HOURS_BLOCK: provider "deepseek" is in peak hours until 10:00 UTC \(about 3 h\).*z-ai, qwen, openai/s,
    );
    expect(logs.some((entry) => entry.message.includes("hard block applied"))).toBe(true);
  });

  test("degrades to an all-peak message when every connected provider is peak-active", async () => {
    const schedules: PeakSchedules = {
      deepseek: { windows: [{ start: "06:00", end: "10:00" }] },
      "z-ai": { windows: [{ start: "06:00", end: "10:00", days: [1, 2, 3, 4, 5] }] },
      qwen: { windows: [{ start: "00:00", end: "14:00" }] },
    };
    const { plugin } = await makePlugin({
      entry: baseEntry({ schedules }),
      connectedProviders: async () => ["deepseek", "z-ai", "qwen"],
    });
    const { input, output } = makeParamsIO({ providerID: "deepseek" });

    await expect(plugin["chat.params"]!(input as never, output as never)).rejects.toThrow(
      /Every connected provider/,
    );
  });

  test("honors a per-provider soft override over the global hard mode", async () => {
    const { plugin } = await makePlugin({
      entry: baseEntry({
        schedules: { deepseek: { mode: "soft", windows: [{ start: "06:00", end: "10:00" }] } },
      }),
    });
    const { input, output } = makeParamsIO({ providerID: "deepseek" });

    await expect(plugin["chat.params"]!(input as never, output as never)).resolves.toBeUndefined();
  });
});

describe("PeakHoursPlugin grace and exemptions", () => {
  test("never hard-blocks a session created before the active window start", async () => {
    const { plugin } = await makePlugin({
      session: async () => ({ createdMs: new Date("2026-08-21T05:00:00.000Z").getTime() }),
    });
    const { input, output } = makeParamsIO({ providerID: "deepseek" });

    await expect(plugin["chat.params"]!(input as never, output as never)).resolves.toBeUndefined();
  });

  test("never hard-blocks a session with a parentID", async () => {
    const { plugin } = await makePlugin({
      session: async () => ({ createdMs: NOW.getTime(), parentID: "ses_parent" }),
    });
    const { input, output } = makeParamsIO({ providerID: "deepseek" });

    await expect(plugin["chat.params"]!(input as never, output as never)).resolves.toBeUndefined();
  });

  test("skips grace when graceActiveSessions is disabled", async () => {
    const { plugin } = await makePlugin({
      entry: baseEntry({ graceActiveSessions: false }),
      session: async () => ({ createdMs: new Date("2026-08-21T05:00:00.000Z").getTime() }),
    });
    const { input, output } = makeParamsIO({ providerID: "deepseek" });

    await expect(plugin["chat.params"]!(input as never, output as never)).rejects.toThrow(
      /PEAK_HOURS_BLOCK/,
    );
  });

  test("fails open to soft when the session lookup fails", async () => {
    const { plugin } = await makePlugin({ session: async () => undefined });
    const { input, output } = makeParamsIO({ providerID: "deepseek" });

    await expect(plugin["chat.params"]!(input as never, output as never)).resolves.toBeUndefined();
  });

  test("ignores internal OpenCode agents entirely", async () => {
    const { plugin } = await makePlugin();
    const { input, output } = makeParamsIO({ agent: "title", providerID: "deepseek" });

    await expect(plugin["chat.params"]!(input as never, output as never)).resolves.toBeUndefined();
  });

  test("treats managed subagent and guardian agents as soft", async () => {
    for (const agent of ["vv-implementer", "guardian"]) {
      const { plugin } = await makePlugin();
      const { input, output } = makeParamsIO({ agent, providerID: "deepseek" });

      await expect(
        plugin["chat.params"]!(input as never, output as never),
      ).resolves.toBeUndefined();
    }
  });
});

describe("PeakHoursPlugin no-op paths", () => {
  test("ignores providers without schedules", async () => {
    const { plugin } = await makePlugin();
    const { input, output } = makeParamsIO({ providerID: "openai" });

    await expect(plugin["chat.params"]!(input as never, output as never)).resolves.toBeUndefined();
  });

  test("ignores requests without a model", async () => {
    const { plugin } = await makePlugin();
    const { input, output } = makeParamsIO({});

    await expect(plugin["chat.params"]!(input as never, output as never)).resolves.toBeUndefined();
  });

  test("ignores providers outside their windows", async () => {
    const { plugin } = await makePlugin({
      now: () => new Date("2026-08-21T12:00:00.000Z"),
    });
    const { input, output } = makeParamsIO({ providerID: "deepseek" });

    await expect(plugin["chat.params"]!(input as never, output as never)).resolves.toBeUndefined();
  });
});

describe("PeakHoursPlugin soft mode", () => {
  test("registers no chat.message hook so nothing is injected into the system prompt", async () => {
    const { plugin } = await makePlugin({ entry: baseEntry({ mode: "soft" }) });
    expect(plugin["chat.message"]).toBeUndefined();
  });

  test("lets a peak-provider LLM request through in chat.params without throwing", async () => {
    const { plugin } = await makePlugin({ entry: baseEntry({ mode: "soft" }) });
    const { input, output } = makeParamsIO({ providerID: "deepseek" });

    await expect(plugin["chat.params"]!(input as never, output as never)).resolves.toBeUndefined();
  });
});

describe("message builders", () => {
  test("buildHardBlockMessage includes wait time and suggestions", () => {
    const message = buildHardBlockMessage(
      "deepseek",
      {
        providerKey: "deepseek",
        providerID: "deepseek",
        window: {
          startMinutes: 360,
          endMinutes: 600,
          crossMidnight: false,
          tz: "UTC",
          days: [0, 1, 2, 3, 4, 5, 6],
        },
        endsAt: new Date("2026-08-21T10:00:00.000Z"),
        startedAt: new Date("2026-08-21T06:00:00.000Z"),
        minutesRemaining: 125,
      },
      ["z-ai", "qwen"],
    );
    expect(message).toContain("until 10:00 UTC (about 2 h 5 min)");
    expect(message).toContain("z-ai, qwen");
  });
});
