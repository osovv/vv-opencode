// FILE: src/plugins/peak-hours/index.test.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify native peak-hours plugin policy gating, hard blocks, grace, kind/agent exemptions, suggestions, soft pass-through, fail-open behavior, and an optional isolated real-host smoke that loads the actual built T-006 plugins on the pinned OpenCode 2.0.18 binary.
//   SCOPE: Unconditional hook registration, per-family captured policy, native model.request hard blocking with dynamic suggestions and all-peak degradation, session-age and parentID grace, internal-kind/internal-agent/subagent exemptions, per-provider mode overrides, default production session/provider/agent registry adapters, lookup-failure fail-open, and a loopback-only real-host smoke proving primary payload context, native usage telemetry, and hard-block zero-dispatch with a soft negative control.
//   DEPENDS: [bun:test, node:fs, node:http, node:path, src/plugins/peak-hours/index.ts, src/lib/peak-hours.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-PLUGIN-PEAK-HOURS, V-M-PLUGIN-PEAK-HOURS, M-E2E-V2-HARNESS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   NOW - Fixed Friday 07:00 UTC evaluation instant used by default fixtures.
//   deepseekSchedules - Schedule fixture with the deepseek peak windows active at NOW.
//   baseEntry - Fully seeded entry fixture.
//   makePlugin - Builds the native plugin with an injected captured policy and deps.
//   loadE2eHost - Runtime dynamic import of the read-only real-host harness helpers.
//   startSmokeHost - Start the pinned host with the actual built T-006 plugins and a loopback provider.
//   providerTraceLines - Parse the recorded provider request trace.
//   withPeakPolicy - Build a vvoc config with a soft/hard/off peak policy active at now.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-006 attempt 2 - Added default-registry adapter coverage and the loopback-only real-host smoke for primary payload context, native usage telemetry, and hard-block zero dispatch.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildHardBlockMessage,
  createPeakHoursPlugin,
  type PeakHoursPluginDependencies,
} from "./index.js";
import {
  createDefaultVvocConfig,
  renderVvocConfig,
  type VvocConfig,
} from "../../lib/vvoc-config.js";
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

function configFor(entry: unknown): VvocConfig {
  const config = createDefaultVvocConfig();
  config.plugins = { ...config.plugins, "peak-hours": entry as never };
  return config;
}

interface NativeModelRequest {
  sessionID: string;
  agent: string;
  model: { providerID: string; id: string };
  kind: string;
}

async function makePlugin(
  options: {
    entry?: PeakHoursEntryConfig;
    policy?: "enabled" | "unknown" | "disabled";
    deps?: Partial<PeakHoursPluginDependencies>;
    /** Override the default registry adapter (defaults to a real envelope-shaped list). */
    agentList?: () => Promise<unknown>;
    /** Provide the default session adapter a real encoded session.get envelope. */
    sessionGet?: (input: { sessionID: string }) => Promise<unknown>;
    /** Provide the default provider adapter a real encoded provider.list envelope. */
    providerList?: () => Promise<unknown>;
    /** Use the production default session adapter backed by `sessionGet`. */
    useDefaultSession?: boolean;
    /** Use the production default provider adapter backed by `providerList`. */
    useDefaultProviders?: boolean;
  } = {},
) {
  const policy = options.policy ?? "enabled";
  const logs: Array<{ level: string; message: string; extra?: Record<string, unknown> }> = [];
  const hooks = new Map<string, (event: NativeModelRequest) => Promise<void> | void>();
  let released = false;
  const entry = options.entry ?? baseEntry();
  const config = configFor(policy === "disabled" ? false : entry);
  const fakeRuntime = {
    snapshots: {
      configFor: async () =>
        policy === "unknown" ? undefined : { familyId: "fam-1", vvoc: config },
      accept: async () => ({ status: "unbound" }),
    },
    release: async () => {
      released = true;
    },
  };
  const defaultAgentList = async () => ({
    location: { directory: "/project" },
    data: [
      { id: "build", name: "Build", mode: "primary" },
      { id: "general", name: "General", mode: "subagent" },
      { id: "explore", name: "Explore", mode: "subagent" },
      { id: "guardian", name: "Guardian", mode: "subagent" },
      { id: "vv-implementer", name: "Implementer", mode: "subagent" },
    ],
  });
  const fakeContext = {
    location: {
      directory: "/project",
      project: { id: "proj", directory: "/project", canonical: "/project" },
    },
    agent: {
      list: options.agentList ?? defaultAgentList,
    },
    session: {
      get: options.sessionGet ?? (async () => ({ time: { created: NOW.getTime() } })),
      hook: async (name: string, callback: (event: NativeModelRequest) => Promise<void> | void) => {
        hooks.set(name, callback);
        return { dispose: async () => undefined };
      },
    },
    provider: {
      list:
        options.providerList ??
        (async () => ({
          location: { directory: "/project" },
          data: [
            { id: "deepseek", name: "DeepSeek" },
            { id: "z-ai", name: "Z.ai" },
            { id: "qwen", name: "Qwen" },
            { id: "openai", name: "OpenAI" },
          ],
        })),
    },
  };
  const sessionDep = options.useDefaultSession
    ? undefined
    : (options.deps?.session ?? (async () => ({ createdMs: NOW.getTime(), parentID: undefined })));
  const providersDep = options.useDefaultProviders
    ? undefined
    : (options.deps?.connectedProviders ?? (async () => ["deepseek", "z-ai", "qwen", "openai"]));
  const plugin = createPeakHoursPlugin({
    acquireRuntime: async () => fakeRuntime as never,
    now: () => NOW,
    ...(sessionDep === undefined ? {} : { session: sessionDep }),
    ...(providersDep === undefined ? {} : { connectedProviders: providersDep }),
    log: (level, message, extra) => logs.push({ level, message, extra }),
    ...options.deps,
  });
  const cleanup = (await plugin.setup(fakeContext as never)) as () => Promise<void>;
  const modelRequest = async (request: Partial<NativeModelRequest> = {}) => {
    const handler = hooks.get("model.request");
    if (handler === undefined) throw new Error("no model.request hook registered");
    await handler({
      sessionID: "ses_1",
      agent: "build",
      model: { providerID: "deepseek", id: "deepseek-chat" },
      kind: "primary",
      ...request,
    });
  };
  return { hooks, modelRequest, logs, cleanup, isReleased: () => released };
}

describe("PeakHoursPlugin gating", () => {
  test("registers the model.request hook unconditionally", async () => {
    const enabled = await makePlugin();
    expect(enabled.hooks.has("model.request")).toBe(true);
    const disabled = await makePlugin({ policy: "disabled" });
    expect(disabled.hooks.has("model.request")).toBe(true);
  });

  test("cleanup disposes the hook and releases the runtime", async () => {
    const harness = await makePlugin();
    expect(harness.isReleased()).toBe(false);
    await harness.cleanup();
    expect(harness.isReleased()).toBe(true);
  });
});

describe("PeakHoursPlugin hard mode", () => {
  test("blocks a non-grace primary request before dispatch with dynamic off-peak suggestions", async () => {
    const harness = await makePlugin();
    await expect(harness.modelRequest()).rejects.toThrow(
      /PEAK_HOURS_BLOCK: provider "deepseek" is in peak hours until 10:00 UTC \(about 3 h\).*z-ai, qwen, openai/s,
    );
    expect(harness.logs.some((entry) => entry.message.includes("hard block applied"))).toBe(true);
  });

  test("degrades to an all-peak message when every connected provider is peak-active", async () => {
    const schedules: PeakSchedules = {
      deepseek: { windows: [{ start: "06:00", end: "10:00" }] },
      "z-ai": { windows: [{ start: "06:00", end: "10:00", days: [1, 2, 3, 4, 5] }] },
      qwen: { windows: [{ start: "00:00", end: "14:00" }] },
    };
    const harness = await makePlugin({
      entry: baseEntry({ schedules }),
      deps: { connectedProviders: async () => ["deepseek", "z-ai", "qwen"] },
    });
    await expect(harness.modelRequest()).rejects.toThrow(/Every connected provider/);
  });

  test("honors a per-provider soft override over the global hard mode", async () => {
    const harness = await makePlugin({
      entry: baseEntry({
        schedules: { deepseek: { mode: "soft", windows: [{ start: "06:00", end: "10:00" }] } },
      }),
    });
    await expect(harness.modelRequest()).resolves.toBeUndefined();
  });
});

describe("PeakHoursPlugin grace and exemptions", () => {
  test("never hard-blocks a session created before the active window start", async () => {
    const harness = await makePlugin({
      deps: {
        session: async () => ({ createdMs: new Date("2026-08-21T05:00:00.000Z").getTime() }),
      },
    });
    await expect(harness.modelRequest()).resolves.toBeUndefined();
  });

  test("never hard-blocks a session with a parentID", async () => {
    const harness = await makePlugin({
      deps: { session: async () => ({ createdMs: NOW.getTime(), parentID: "ses_parent" }) },
    });
    await expect(harness.modelRequest()).resolves.toBeUndefined();
  });

  test("skips grace when graceActiveSessions is disabled", async () => {
    const harness = await makePlugin({
      entry: baseEntry({ graceActiveSessions: false }),
      deps: {
        session: async () => ({ createdMs: new Date("2026-08-21T05:00:00.000Z").getTime() }),
      },
    });
    await expect(harness.modelRequest()).rejects.toThrow(/PEAK_HOURS_BLOCK/);
  });

  test("fails open to soft when the session lookup fails", async () => {
    const harness = await makePlugin({ deps: { session: async () => undefined } });
    await expect(harness.modelRequest()).resolves.toBeUndefined();
  });

  test("ignores internal OpenCode agents entirely", async () => {
    const harness = await makePlugin();
    await expect(harness.modelRequest({ agent: "title" })).resolves.toBeUndefined();
    await expect(harness.modelRequest({ agent: "compaction" })).resolves.toBeUndefined();
  });

  test("exempts auxiliary request kinds (title, compaction, generate)", async () => {
    const harness = await makePlugin();
    for (const kind of ["title", "compaction", "generate"]) {
      await expect(harness.modelRequest({ kind })).resolves.toBeUndefined();
    }
  });

  test("treats managed subagent and guardian agents as soft", async () => {
    const harness = await makePlugin();
    for (const agent of ["vv-implementer", "guardian"]) {
      await expect(harness.modelRequest({ agent })).resolves.toBeUndefined();
    }
  });

  test("exempts a custom agent whose native registry mode is subagent", async () => {
    const harness = await makePlugin({
      deps: { agentMode: async (agent) => (agent === "reviewer" ? "subagent" : "primary") },
    });
    await expect(harness.modelRequest({ agent: "reviewer" })).resolves.toBeUndefined();
  });

  test("default registry adapter treats native subagent-mode agents as soft and recovers from a transient failure", async () => {
    let calls = 0;
    const harness = await makePlugin({
      agentList: async () => {
        calls += 1;
        if (calls === 1) throw new Error("registry unavailable");
        return {
          location: { directory: "/project" },
          data: [
            { id: "build", name: "Build", mode: "primary" },
            { id: "explore", name: "Explore", mode: "subagent" },
          ],
        };
      },
    });
    // The transient failure must not poison the request: unknown mode means the
    // agent is treated as non-subagent and the hard block still fires.
    await expect(harness.modelRequest({ agent: "build" })).rejects.toThrow(/PEAK_HOURS_BLOCK/);
    // Recovery: the real envelope mode marks explore as a subagent -> soft.
    await expect(harness.modelRequest({ agent: "explore" })).resolves.toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("default registry adapter reflects a newly configured subagent without restart", async () => {
    const modes = new Map<string, "subagent" | "primary">([["build", "primary"]]);
    const harness = await makePlugin({
      agentList: async () => ({
        location: { directory: "/project" },
        data: [...modes.entries()].map(([id, mode]) => ({ id, mode })),
      }),
    });
    await expect(harness.modelRequest({ agent: "new-worker" })).rejects.toThrow(/PEAK_HOURS_BLOCK/);
    modes.set("new-worker", "subagent");
    await expect(harness.modelRequest({ agent: "new-worker" })).resolves.toBeUndefined();
  });

  test("production default session adapter reads encoded numeric time and parentID", async () => {
    const oldSession = await makePlugin({
      useDefaultSession: true,
      sessionGet: async () => ({
        time: { created: new Date("2026-08-21T05:00:00.000Z").getTime() },
      }),
    });
    await expect(oldSession.modelRequest()).resolves.toBeUndefined();

    const child = await makePlugin({
      useDefaultSession: true,
      sessionGet: async () => ({ time: { created: NOW.getTime() }, parentID: "ses_parent" }),
    });
    await expect(child.modelRequest()).resolves.toBeUndefined();

    const missing = await makePlugin({
      useDefaultSession: true,
      sessionGet: async () => {
        throw new Error("session lookup failed");
      },
    });
    await expect(missing.modelRequest()).resolves.toBeUndefined();
  });

  test("production default provider adapter reads the encoded provider envelope for suggestions", async () => {
    const harness = await makePlugin({
      useDefaultSession: true,
      useDefaultProviders: true,
      sessionGet: async () => ({ time: { created: NOW.getTime() } }),
      providerList: async () => ({
        location: { directory: "/project" },
        data: [
          { id: "deepseek", name: "DeepSeek" },
          { id: "z-ai", name: "Z.ai" },
          { id: "openai", name: "OpenAI" },
        ],
      }),
    });
    await expect(harness.modelRequest()).rejects.toThrow(/z-ai, openai/);
  });
});

describe("PeakHoursPlugin no-op paths", () => {
  test("ignores providers without schedules", async () => {
    const harness = await makePlugin();
    await expect(
      harness.modelRequest({ model: { providerID: "openai", id: "gpt" } }),
    ).resolves.toBeUndefined();
  });

  test("ignores providers outside their windows", async () => {
    const harness = await makePlugin({ deps: { now: () => new Date("2026-08-21T12:00:00.000Z") } });
    await expect(harness.modelRequest()).resolves.toBeUndefined();
  });

  test("an unknown family policy never blocks", async () => {
    const harness = await makePlugin({ policy: "unknown" });
    await expect(harness.modelRequest()).resolves.toBeUndefined();
  });
});

describe("PeakHoursPlugin soft mode", () => {
  test("lets a peak-provider request through in soft mode without throwing", async () => {
    const harness = await makePlugin({ entry: baseEntry({ mode: "soft" }) });
    await expect(harness.modelRequest()).resolves.toBeUndefined();
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

// START_BLOCK_REAL_HOST_SMOKE
/**
 * Optional isolated real-host smoke. Runs only when VVOC_E2E_V2_HOST points at
 * the pinned OpenCode 2.0.18 binary; otherwise it is skipped. It loads the ACTUAL
 * built T-006 plugins plus ModelRoles on the same native context, drives real
 * primary prompts through a loopback-only provider, and proves: the primary
 * request payload receives the injected system context, real native
 * `session.step.ended` usage becomes an analytics record, and a hard peak policy
 * yields ZERO primary provider dispatches while the soft control does dispatch.
 *
 * Isolation, owned scratch/processes, allow-listed env, the loopback guard,
 * service-registration wait and the authenticated bounded HTTP client are reused
 * READ-ONLY from scripts/e2e-v2/host.ts via a runtime dynamic import, so this
 * in-scope test never duplicates (or weakens) that safety surface.
 */
const REAL_T006_HOST = process.env.VVOC_E2E_V2_HOST;
const t006SmokeDescribe = REAL_T006_HOST ? describe : describe.skip;

type E2eHostModule = {
  PINNED_HOST_SHA256: string;
  sha256File(path: string): Promise<string>;
  createOwnedScratch(base: string): Promise<{ dir: string; base: string; markerPath: string }>;
  removeOwnedScratch(scratch: unknown): Promise<void>;
  waitForRegisteredService(input: { servicePath: string; timeoutMs?: number }): Promise<string>;
  createNativeApi(input: {
    baseUrl: string;
    password: string;
    directory: string;
    timeoutMs?: number;
  }): (
    path: string,
    init?: RequestInit,
  ) => Promise<{ status: number; body: unknown; text: string }>;
  assertLoopbackHttpUrl(raw: string, label?: string): URL;
  buildHostEnv(
    base: Record<string, string>,
    extra?: Record<string, string | undefined>,
  ): Record<string, string>;
  OwnedProcesses: new () => {
    spawn(
      command: string,
      args: readonly string[],
      options?: { cwd?: string; env?: Record<string, string> },
    ): unknown;
    stopAll(signal?: NodeJS.Signals, timeoutMs?: number): Promise<void>;
  };
};

let e2eHostPromise: Promise<E2eHostModule> | undefined;
const loadE2eHost = (): Promise<E2eHostModule> =>
  (e2eHostPromise ??= import(
    new URL("../../../scripts/e2e-v2/host.ts", import.meta.url).href
  ) as Promise<E2eHostModule>);

async function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

const smokeSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type PeakSmokeMode = "soft" | "hard";

/** Build a vvoc config with a soft/hard peak policy active around the current UTC hour. */
function withPeakPolicy(mode: PeakSmokeMode): string {
  const config: VvocConfig = createDefaultVvocConfig();
  config.roles = {
    default: "loopback/seam-smart#plain",
    smart: "loopback/seam-smart#plain",
    fast: "loopback/seam-smart#plain",
    reviewer: "loopback/seam-smart#plain",
  };
  const pad = (value: number): string => String(value).padStart(2, "0");
  const now = new Date();
  const before = new Date(now.getTime() - 60 * 60 * 1000);
  const after = new Date(now.getTime() + 60 * 60 * 1000);
  const hhmm = (date: Date): string => `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
  config.plugins = {
    ...config.plugins,
    "peak-hours": {
      enabled: true,
      mode,
      graceActiveSessions: false,
      schedules: { loopback: { windows: [{ start: hhmm(before), end: hhmm(after), tz: "UTC" }] } },
    },
  };
  return renderVvocConfig(config);
}

/** Generated plugin module composing the actual built T-006 plugins and ModelRoles on one context. */
function smokePluginSource(distRoot: string): string {
  const importLine = (name: string, local: string): string =>
    `import ${local} from ${JSON.stringify(join(distRoot, "plugins", name, "index.js"))};`;
  return [
    importLine("model-roles", "modelRoles"),
    importLine("system-context-injection", "systemContext"),
    importLine("tool-history-compaction", "toolHistory"),
    importLine("analytics", "analytics"),
    importLine("peak-hours", "peakHours"),
    `const plugins = [modelRoles, systemContext, toolHistory, analytics, peakHours];`,
    `export default {`,
    `  id: "vvoc.t006.smoke",`,
    `  async setup(ctx) {`,
    `    const cleanups = [];`,
    `    for (const plugin of plugins) {`,
    `      const cleanup = await plugin.setup(ctx);`,
    `      if (cleanup) cleanups.push(cleanup);`,
    `    }`,
    `    return async () => {`,
    `      for (const cleanup of cleanups.reverse()) await cleanup();`,
    `    };`,
    `  },`,
    `};`,
    ``,
  ].join("\n");
}

function smokeProviderScript(port: number, tracePath: string): string {
  return [
    `import { appendFileSync, mkdirSync } from "node:fs";`,
    `import { dirname } from "node:path";`,
    `const trace = ${JSON.stringify(tracePath)};`,
    `const stamp = (r) => { mkdirSync(dirname(trace), { recursive: true }); appendFileSync(trace, JSON.stringify({ at: Date.now(), ...r }) + "\\n"); };`,
    `const chunk = (model, delta, finish) => "data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] }) + "\\n\\n";`,
    `const sseText = (model, text) => chunk(model, { role: "assistant" }, null) + chunk(model, { content: text }, null) + chunk(model, {}, "stop") + "data: [DONE]\\n\\n";`,
    `Bun.serve({ hostname: "127.0.0.1", port: ${port}, async fetch(request) {`,
    `  const url = new URL(request.url);`,
    `  const body = await request.clone().json().catch(() => ({}));`,
    `  const model = body?.model ?? "unknown";`,
    `  stamp({ event: "provider.request", path: url.pathname, model, body });`,
    `  if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "seam-smart", object: "model", created: 1, owned_by: "loopback" }] });`,
    `  if (body?.stream) return new Response(sseText(model, "t006-smoke-ok"), { headers: { "content-type": "text/event-stream" } });`,
    `  return Response.json({ id: "c", object: "chat.completion", created: 1, model, choices: [{ index: 0, message: { role: "assistant", content: "t006-smoke-ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });`,
    `} });`,
    ``,
  ].join("\n");
}

function providerTraceLines(
  tracePath: string,
): Array<{ event?: string; model?: string; body?: unknown }> {
  try {
    return readFileSync(tracePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: string; model?: string; body?: unknown });
  } catch {
    return [];
  }
}

function readUsageRecords(dataHome: string): Array<Record<string, unknown>> {
  const dir = join(dataHome, "vvoc", "analytics");
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const records: Array<Record<string, unknown>> = [];
  for (const file of files) {
    if (!/^usage-\d{4}-\d{2}\.jsonl$/.test(file)) continue;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        records.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Corrupt line: skip.
      }
    }
  }
  return records;
}

t006SmokeDescribe("real OpenCode 2.0.18 T-006 smoke (actual built plugins)", () => {
  type Started = {
    sessionID: string;
    providerTrace: string;
    dataHome: string;
    terminalOutcome: string | undefined;
    stop: () => Promise<void>;
  };

  async function startSmokeHost(options: {
    peak: PeakSmokeMode;
    promptText: string;
  }): Promise<Started> {
    const helpers = await loadE2eHost();
    const hostSha = await helpers.sha256File(REAL_T006_HOST as string);
    if (hostSha !== helpers.PINNED_HOST_SHA256) {
      throw new Error(`refusing unpinned host ${REAL_T006_HOST}: sha256 ${hostSha}`);
    }
    const scratch = await helpers.createOwnedScratch(
      process.env.VVOC_E2E_SCRATCH ?? "/tmp/opencode",
    );
    const root = scratch.dir;
    for (const sub of [
      "project",
      "project/.vvoc",
      "trace",
      "home",
      "cfg",
      "data",
      "state",
      "cache",
      "plugin",
    ]) {
      mkdirSync(join(root, sub), { recursive: true });
    }
    const procs = new helpers.OwnedProcesses();
    const providerPort = await getFreePort();
    const hostPort = await getFreePort();
    const providerTrace = join(root, "trace", "provider.jsonl");
    const providerOrigin = `http://127.0.0.1:${providerPort}`;
    helpers.assertLoopbackHttpUrl(providerOrigin, "smoke provider origin");
    const env = helpers.buildHostEnv(process.env as Record<string, string>, {
      PATH: process.env.PATH,
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "cfg"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
      LOOPBACK_API_KEY: "t006-smoke-key",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
    });
    const project = join(root, "project");
    const distRoot = join(import.meta.dir, "..", "..", "..", "dist");

    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      await procs.stopAll();
      await helpers.removeOwnedScratch(scratch);
    };

    try {
      writeFileSync(
        join(root, "provider.ts"),
        smokeProviderScript(providerPort, providerTrace),
        "utf8",
      );
      procs.spawn(process.execPath, [join(root, "provider.ts")], { env });
      let listening = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          await fetch(providerOrigin, { method: "HEAD", signal: AbortSignal.timeout(500) });
          listening = true;
          break;
        } catch {
          await smokeSleep(100);
        }
      }
      if (!listening) throw new Error("loopback provider did not start listening");

      writeFileSync(
        join(root, "plugin", "package.json"),
        JSON.stringify({ name: "vvoc-t006-smoke-plugin", private: true, version: "0.0.0" }),
        "utf8",
      );
      writeFileSync(join(root, "plugin", "index.ts"), smokePluginSource(distRoot), "utf8");
      writeFileSync(
        join(project, "opencode.json"),
        JSON.stringify(
          {
            model: "loopback/seam-smart",
            agents: {
              build: {
                model: "loopback/seam-smart",
                mode: "primary",
                permissions: [{ action: "*", resource: "*", effect: "allow" }],
              },
            },
            providers: {
              loopback: {
                name: "T006 Smoke Loopback",
                package: "@opencode/ai/providers/openai-compatible",
                env: ["LOOPBACK_API_KEY"],
                settings: { baseURL: `${providerOrigin}/v1`, provider: "loopback" },
                models: {
                  "seam-smart": {
                    name: "Seam Smart",
                    variants: [{ id: "plain", settings: { reasoningEffort: "minimal" } }],
                  },
                },
              },
            },
            plugins: [{ package: join(root, "plugin") }],
          },
          null,
          2,
        ),
        "utf8",
      );
      writeFileSync(join(project, ".vvoc", "vvoc.json"), withPeakPolicy(options.peak), "utf8");

      procs.spawn(
        REAL_T006_HOST as string,
        [
          "serve",
          "--service",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(hostPort),
          "--log-level",
          "error",
        ],
        { env },
      );
      const servicePath = join(root, "state", "opencode", "service.json");
      const password = await helpers.waitForRegisteredService({ servicePath, timeoutMs: 30_000 });
      const api = helpers.createNativeApi({
        baseUrl: `http://127.0.0.1:${hostPort}`,
        password,
        directory: project,
      });

      // Service registration is not app/agent/model readiness: wait for the real
      // registry before creating a session.
      let agentReady = false;
      let modelReady = false;
      const readyDeadline = Date.now() + 45_000;
      for (;;) {
        if (!agentReady) {
          const agents = await api("/api/agent").catch(() => undefined);
          agentReady = agents?.status === 200 && agents.text.includes("build");
        }
        if (!modelReady) {
          const models = await api("/api/model").catch(() => undefined);
          modelReady = models?.status === 200 && models.text.includes("seam-smart");
        }
        if (agentReady && modelReady) break;
        if (Date.now() > readyDeadline) {
          throw new Error(
            `host app/agent/model registry not ready (agent=${agentReady} model=${modelReady})`,
          );
        }
        await smokeSleep(250);
      }

      const created = await api("/api/session", {
        method: "POST",
        body: JSON.stringify({ location: { directory: project }, agent: "build" }),
      });
      const createdID =
        typeof created.body === "object" && created.body !== null
          ? (created.body as { data?: { id?: unknown } }).data?.id
          : undefined;
      if (typeof createdID !== "string") {
        throw new Error(
          `session create returned no id: ${created.status} ${created.text.slice(0, 400)}`,
        );
      }
      const promptAt = Date.now();
      const prompted = await api(`/api/session/${createdID}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text: options.promptText }),
      });
      if (prompted.status >= 400) {
        throw new Error(`session prompt failed: ${prompted.status} ${prompted.text.slice(0, 400)}`);
      }

      // Wait for a fresh terminal state regardless of outcome; the hard-block case
      // still settles with a failed execution.
      const terminalDeadline = Date.now() + 90_000;
      let terminalOutcome: string | undefined;
      for (;;) {
        const context = await api(`/api/session/${createdID}/context`).catch(() => undefined);
        const data =
          context && typeof context.body === "object" && context.body !== null
            ? (context.body as { data?: unknown }).data
            : undefined;
        const idle = Array.isArray(data)
          ? data.find(
              (
                message,
              ): message is { type: string; outcome?: unknown; time?: { created?: unknown } } =>
                typeof message === "object" &&
                message !== null &&
                (message as { type?: unknown }).type === "idle" &&
                typeof (message as { time?: { created?: unknown } }).time?.created === "number" &&
                ((message as { time: { created: number } }).time.created as number) >= promptAt,
            )
          : undefined;
        if (idle !== undefined) {
          terminalOutcome = typeof idle.outcome === "string" ? idle.outcome : undefined;
          break;
        }
        if (Date.now() > terminalDeadline) {
          throw new Error(`session ${createdID} did not reach a fresh terminal state`);
        }
        await smokeSleep(400);
      }

      return {
        sessionID: createdID,
        providerTrace,
        dataHome: join(root, "data"),
        terminalOutcome,
        stop,
      };
    } catch (error) {
      await stop();
      throw error;
    }
  }

  test("soft peak control dispatches the primary payload with injected context and emits native usage", async () => {
    const started = await startSmokeHost({ peak: "soft", promptText: "T006 soft control prompt" });
    try {
      expect(started.terminalOutcome).toBe("succeeded");
      const requests = providerTraceLines(started.providerTrace).filter(
        (line) => line.event === "provider.request",
      );
      const primary = requests.filter((line) =>
        JSON.stringify(line.body).includes("<working_state>"),
      );
      expect(primary.length).toBeGreaterThan(0);
      expect(JSON.stringify(primary[0]!.body)).toContain("<correctness_obligations>");

      // Real native session.step.ended usage must land in the analytics store.
      let usage: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 40 && usage === undefined; attempt += 1) {
        usage = readUsageRecords(started.dataHome).find(
          (record) => record.kind === "usage" && record.sessionID === started.sessionID,
        );
        if (usage === undefined) await smokeSleep(250);
      }
      expect(usage).toBeDefined();
      expect(usage!.partID).toMatch(/^evt_/);
      expect(usage!.messageID).toMatch(/^msg_/);
      expect(usage!.tokens).toBeDefined();
    } finally {
      await started.stop();
    }
  }, 180000);

  test("hard peak denies the primary before dispatch while the title/auxiliary path is distinct", async () => {
    const started = await startSmokeHost({ peak: "hard", promptText: "T006 hard block prompt" });
    try {
      // The execution actually failed at the peak gate rather than the prompt
      // being silently ignored.
      expect(started.terminalOutcome).toBe("failed");
      const requests = providerTraceLines(started.providerTrace).filter(
        (line) => line.event === "provider.request",
      );
      // The primary context carries `<working_state>`; a hard block must prevent
      // any primary dispatch. Title/auxiliary requests never carry it, so this
      // marker counts primary dispatches only.
      const primaryDispatches = requests.filter((line) =>
        JSON.stringify(line.body).includes("<working_state>"),
      );
      expect(primaryDispatches).toHaveLength(0);
    } finally {
      await started.stop();
    }
  }, 180000);
});
// END_BLOCK_REAL_HOST_SMOKE
