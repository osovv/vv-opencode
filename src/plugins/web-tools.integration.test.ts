// FILE: src/plugins/web-tools.integration.test.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the native WebToolsPlugin per-family behavior: stable owned registration, owned vs genuine native builtin visibility selected from the bound capture, fail-closed unknown policy, execute-time policy gating before permission/network effects, and credential-safe diagnostics.
//   SCOPE: Native-boundary tests using an injected shared-runtime seam, a recording native tool editor, recording session hooks, and a recording permission guard; deterministic fetch stubs where dispatch must be proven absent.
//   DEPENDS: [bun:test, @opencode/plugin/promise/tool, src/lib/agent-tool-contract.ts, src/lib/plugin-toggle-config.ts, src/lib/vvoc-config.ts, src/plugins/web-tools/index.ts]
//   LINKS: M-PLUGIN-WEB-TOOLS, V-M-PLUGIN-WEB-TOOLS, M-AGENT-TOOL-CONTRACT, DF-WEB-SEARCH, DF-WEB-FETCH, M-NATIVE-RUNTIME
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ORIGINAL_ENV - Credential environment values restored after each test.
//   RecordingEditor - Native tool editor fixture collecting add/remove calls.
//   RecordingPermission - Recording resource permission guard.
//   createHarness - Build a native plugin harness with per-session policy and recording hooks.
//   createToolContext - Build a pinned native tool execute context fixture.
//   disabledConfig - Build a config with web-tools explicitly disabled.
//   AddedTool - Registered native tool fixture.
//   NativeSessionEvent - Native session context event fixture.
//   SessionHandler - Native session hook handler fixture.
//   createPermission - Build a recording resource permission guard.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-005 attempt 2 - Rewrote the startup-toggle tests as per-session policy visibility tests (enabled owned contracts, disabled genuine native builtins, unknown exposes neither) plus execute-time policy gating.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { ContractInputError } from "../lib/agent-tool-contract.js";
import { resetVvocConfigForTests } from "../lib/config-layers.js";
import { createDefaultVvocConfig, type VvocConfig } from "../lib/vvoc-config.js";
import { createWebToolsPlugin } from "./web-tools/index.js";

const ORIGINAL_ENV = {
  EXA_API_KEY: process.env.EXA_API_KEY,
  BRAVE_API_KEY: process.env.BRAVE_API_KEY,
  SPIDER_API_KEY: process.env.SPIDER_API_KEY,
  ZAI_API_KEY: process.env.ZAI_API_KEY,
};

afterEach(() => {
  resetVvocConfigForTests();
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

interface AddedTool {
  readonly name: string;
  execute(input: unknown, context: ToolContext): Promise<unknown>;
}

class RecordingEditor {
  readonly added: AddedTool[] = [];
  readonly removed: string[] = [];
  add(tool: AddedTool): void {
    this.added.push(tool);
  }
  remove(id: string): void {
    this.removed.push(id);
  }
  list(): readonly unknown[] {
    return [];
  }
  get(): unknown {
    return undefined;
  }
  namespace(): void {}
  update(): void {}
}

interface RecordingPermission {
  readonly calls: Array<{ action: string; resources: ReadonlyArray<string> }>;
  guard(
    input: { action: string; resources: ReadonlyArray<string> },
    effect: () => Promise<unknown> | unknown,
  ): Promise<unknown>;
}

function createPermission(): RecordingPermission {
  const calls: Array<{ action: string; resources: ReadonlyArray<string> }> = [];
  return {
    calls,
    async guard(input, effect) {
      calls.push({ action: input.action, resources: input.resources });
      return effect();
    },
  };
}

type NativeSessionEvent = { sessionID: string; tools?: Record<string, unknown> };
type SessionHandler = (event: NativeSessionEvent) => Promise<void> | void;

async function createHarness(
  config: VvocConfig,
  options: {
    policy?: "enabled" | "disabled" | "unknown";
    tools?: Record<string, unknown>;
    sourcePath?: string;
  } = {},
) {
  resetVvocConfigForTests();
  const policy = options.policy ?? "enabled";
  const logs: Array<{ level: string; message: string; extra?: unknown }> = [];
  const editor = new RecordingEditor();
  const permission = createPermission();
  const sessionHooks = new Map<string, SessionHandler>();
  let released = false;
  const capture = { familyId: "fam-1", vvoc: config };
  const fakeRuntime = {
    snapshots: {
      configFor: async () => (policy === "unknown" ? undefined : capture),
      accept: async () => ({ status: "unbound" }),
    },
    permissions: permission,
    effectiveConfig: () => ({
      vvoc: config,
      ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
    }),
    release: async () => {
      released = true;
    },
  };
  const fakeContext = {
    location: {
      directory: "/tmp/project",
      project: { id: "proj", directory: "/tmp/project", canonical: "/tmp/project" },
    },
    tool: {
      transform: async (callback: (target: RecordingEditor) => void) => {
        callback(editor);
        return { dispose: async () => undefined };
      },
    },
    session: {
      hook: async (name: string, callback: SessionHandler) => {
        sessionHooks.set(name, callback);
        return { dispose: async () => undefined };
      },
    },
  };
  const plugin = createWebToolsPlugin({
    acquireRuntime: async () => fakeRuntime as never,
    log: (event) => logs.push(event),
  });
  await plugin.setup(fakeContext as never);
  const runContext = async (tools?: Record<string, unknown>) => {
    const handler = sessionHooks.get("context");
    if (handler === undefined) throw new Error("no context hook registered");
    const event: NativeSessionEvent = {
      sessionID: "s1",
      ...(tools === undefined ? {} : { tools }),
    };
    await handler(event);
    return event;
  };
  return { logs, editor, permission, sessionHooks, runContext, isReleased: () => released };
}

function createToolContext(): ToolContext {
  return {
    sessionID: "s1",
    agent: "test-agent",
    messageID: "message-1",
    id: "call-1",
    signal: new AbortController().signal,
    progress: async () => undefined,
  } as unknown as ToolContext;
}

function disabledConfig(): VvocConfig {
  const config = createDefaultVvocConfig();
  config.plugins = { ...config.plugins, "web-tools": false };
  return config;
}

describe("WebToolsPlugin registration", () => {
  test("registers exactly the two owned tools regardless of startup config", async () => {
    const enabled = await createHarness(createDefaultVvocConfig());
    expect(enabled.editor.added.map((tool) => tool.name).sort()).toEqual([
      "web_fetch",
      "web_search",
    ]);
    expect(enabled.editor.removed).toEqual([]);

    const disabled = await createHarness(disabledConfig());
    // Stable registration: a startup-disabled capture must not remove the tools
    // another family still uses or block a later enabled family.
    expect(disabled.editor.added.map((tool) => tool.name).sort()).toEqual([
      "web_fetch",
      "web_search",
    ]);
    expect(disabled.editor.removed).toEqual([]);
  });

  test("releases the shared runtime and disposes hooks on cleanup", async () => {
    const harness = await createHarness(createDefaultVvocConfig());
    expect(harness.isReleased()).toBe(false);
    expect(harness.sessionHooks.has("context")).toBe(true);
    expect(harness.sessionHooks.has("compaction")).toBe(true);
    expect(harness.sessionHooks.has("generate")).toBe(true);
  });
});

describe("WebToolsPlugin per-family visibility", () => {
  test("an enabled capture publishes the owned contracts and hides native builtins", async () => {
    const harness = await createHarness(createDefaultVvocConfig());
    const event = await harness.runContext({
      websearch: { description: "native", input: {} },
      webfetch: { description: "native", input: {} },
    });
    const tools = event.tools!;
    expect(tools.websearch).toBeUndefined();
    expect(tools.webfetch).toBeUndefined();
    expect(tools.web_search).toMatchObject({ input: expect.any(Object) });
    expect(tools.web_fetch).toMatchObject({ input: expect.any(Object) });
  });

  test("a disabled capture exposes the genuine native builtins and hides owned tools", async () => {
    const harness = await createHarness(disabledConfig());
    const event = await harness.runContext({
      websearch: { description: "native-search", input: { type: "object" } },
      webfetch: { description: "native-fetch", input: { type: "object" } },
      web_search: { description: "owned", input: {} },
      web_fetch: { description: "owned", input: {} },
    });
    const tools = event.tools!;
    expect(tools.web_search).toBeUndefined();
    expect(tools.web_fetch).toBeUndefined();
    expect(tools.websearch).toEqual({ description: "native-search", input: { type: "object" } });
    expect(tools.webfetch).toEqual({ description: "native-fetch", input: { type: "object" } });
  });

  test("startup-enabled config does not hijack a disabled captured family", async () => {
    const harness = await createHarness(disabledConfig(), { policy: "disabled" });
    const event = await harness.runContext({
      websearch: { description: "native", input: {} },
    });
    expect(event.tools!.web_search).toBeUndefined();
    expect(event.tools!.websearch).toEqual({ description: "native", input: {} });
  });

  test("an unknown policy exposes neither owned nor native web tools", async () => {
    const harness = await createHarness(createDefaultVvocConfig(), { policy: "unknown" });
    const event = await harness.runContext({
      websearch: { description: "native", input: {} },
      webfetch: { description: "native", input: {} },
      web_search: { description: "owned", input: {} },
    });
    const tools = event.tools!;
    expect(tools.web_search).toBeUndefined();
    expect(tools.websearch).toBeUndefined();
    expect(tools.webfetch).toBeUndefined();
  });
});

describe("WebToolsPlugin execute guards", () => {
  test("direct owned execute rejects invalid arguments before permission or dispatch", async () => {
    const harness = await createHarness(createDefaultVvocConfig());
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("unexpected");
    }) as unknown as typeof fetch;
    try {
      const search = harness.editor.added.find((tool) => tool.name === "web_search")!;
      const fetch = harness.editor.added.find((tool) => tool.name === "web_fetch")!;
      const context = createToolContext();
      await expect(search.execute({ query: "vvoc", count: 0 }, context)).rejects.toBeInstanceOf(
        ContractInputError,
      );
      await expect(fetch.execute({ url: "file:///tmp/secret" }, context)).rejects.toBeInstanceOf(
        ContractInputError,
      );
      expect(harness.permission.calls).toEqual([]);
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a disabled captured family refuses the owned provider-bound path", async () => {
    const harness = await createHarness(disabledConfig(), { policy: "disabled" });
    const search = harness.editor.added.find((tool) => tool.name === "web_search")!;
    await expect(search.execute({ query: "vvoc" }, createToolContext())).rejects.toThrow(
      /disabled by the captured policy/,
    );
  });

  test("an unknown policy refuses the owned provider-bound path", async () => {
    const harness = await createHarness(createDefaultVvocConfig(), { policy: "unknown" });
    const fetch = harness.editor.added.find((tool) => tool.name === "web_fetch")!;
    await expect(
      fetch.execute({ url: "https://example.test" }, createToolContext()),
    ).rejects.toThrow(/no trustworthy web-tools policy/);
  });
});

describe("WebToolsPlugin diagnostics", () => {
  test("logs provider names and credential sources without credential values", async () => {
    process.env.BRAVE_API_KEY = "environment-brave-secret";
    const config = createDefaultVvocConfig();
    config.web = {
      search: { provider: "brave", apiKey: "config-brave-secret" },
      fetch: { provider: "spider", apiKey: "config-spider-secret" },
    };
    const harness = await createHarness(config);
    await harness.runContext({});
    const serialized = JSON.stringify(harness.logs);
    expect(
      harness.logs.find((entry) => entry.message === "web tools configuration loaded"),
    ).toMatchObject({
      level: "info",
      extra: {
        familyId: "fam-1",
        searchProvider: "brave",
        searchCredentialSource: "env",
        fetchProvider: "spider",
        fetchCredentialSource: "config",
      },
    });
    expect(serialized).not.toContain("environment-brave-secret");
    expect(serialized).not.toContain("config-brave-secret");
    expect(serialized).not.toContain("config-spider-secret");
  });

  test("logs direct Z.AI regions and credential sources without values", async () => {
    process.env.ZAI_API_KEY = "environment-zai-secret";
    const config = createDefaultVvocConfig();
    config.web = {
      search: { provider: "zai", region: "international", apiKey: "search-config-secret" },
      fetch: { provider: "zai", region: "china", apiKey: "fetch-config-secret" },
    };
    const harness = await createHarness(config);
    await harness.runContext({});
    const serialized = JSON.stringify(harness.logs);
    expect(
      harness.logs.find((entry) => entry.message === "web tools configuration loaded"),
    ).toMatchObject({
      level: "info",
      extra: {
        searchProvider: "zai",
        searchRegion: "international",
        searchCredentialSource: "env",
        fetchProvider: "zai",
        fetchRegion: "china",
        fetchCredentialSource: "env",
      },
    });
    expect(serialized).not.toContain("environment-zai-secret");
    expect(serialized).not.toContain("search-config-secret");
    expect(serialized).not.toContain("fetch-config-secret");
  });

  test("warns when the selected project config stores a literal apiKey and is git-tracked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vvoc-web-tracked-"));
    const tracked = join(directory, ".vvoc", "vvoc.json");
    await mkdir(join(directory, ".vvoc"), { recursive: true });
    await writeFile(
      tracked,
      JSON.stringify({ web: { search: { apiKey: "literal-tracked-key" } } }),
      "utf8",
    );
    Bun.spawnSync(["git", "init", "-q"], { cwd: directory });
    Bun.spawnSync(["git", "add", "-f", ".vvoc/vvoc.json"], { cwd: directory });
    try {
      const config = createDefaultVvocConfig();
      config.web = { search: { provider: "exa", apiKey: "literal-tracked-key" } };
      const harness = await createHarness(config, { sourcePath: tracked });
      const serialized = JSON.stringify(harness.logs);
      expect(serialized).toContain("tracked by git");
      expect(serialized).not.toContain("literal-tracked-key");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not warn for env-only credentials or a missing source", async () => {
    const envOnly = createDefaultVvocConfig();
    envOnly.web = { search: { provider: "exa", apiKey: "${EXA_API_KEY}" } };
    const withoutSource = await createHarness(envOnly);
    expect(JSON.stringify(withoutSource.logs)).toContain("config source unknown");

    const noKey = createDefaultVvocConfig();
    const noKeyHarness = await createHarness(noKey, { sourcePath: "/tmp/nonexistent/vvoc.json" });
    expect(JSON.stringify(noKeyHarness.logs)).not.toContain("tracked by git");
  });
});
