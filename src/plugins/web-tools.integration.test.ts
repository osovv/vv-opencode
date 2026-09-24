// FILE: src/plugins/web-tools.integration.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify WebToolsPlugin toggle behavior, canonical tool registration, owned contract publication and pre-execute validation, runtime built-in suppression, diagnostics, and tracked-config warnings.
//   SCOPE: Plugin-level tests using isolated vvoc project configs and stubbed OpenCode logging; deterministic fetch stubs where dispatch must be proven absent.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, @opencode-ai/plugin, src/lib/agent-tool-contract.ts, src/lib/config-layers.ts, src/lib/vvoc-config.ts, src/plugins/web-tools/index.ts]
//   LINKS: M-PLUGIN-WEB-TOOLS, V-M-PLUGIN-WEB-TOOLS, M-AGENT-TOOL-CONTRACT, DF-WEB-SEARCH, DF-WEB-FETCH
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   tempDirs - Isolated project directories scheduled for cleanup.
//   ORIGINAL_ENV - Credential environment values restored after each test.
//   createProject - Write an isolated project-layer vvoc config.
//   createPluginInput - Build a stubbed OpenCode PluginInput.
//   createPlugin - Instantiate WebToolsPlugin with isolated config and log capture.
//   createToolContext - Build a tool execution context fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-006 - Covered owned definition publication, owned-only pre-execute rejection with no permission/dispatch, and direct execute rejection while preserving toggle, suppression, and diagnostics behavior.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, PluginInput, ToolContext } from "@opencode-ai/plugin";
import { ContractInputError } from "../lib/agent-tool-contract.js";
import { resetVvocConfigForTests } from "../lib/config-layers.js";
import { createDefaultVvocConfig, type VvocConfig } from "../lib/vvoc-config.js";
import { applyBuiltinSuppression, WebToolsPlugin } from "./web-tools/index.js";

const tempDirs: string[] = [];
const ORIGINAL_ENV = {
  EXA_API_KEY: process.env.EXA_API_KEY,
  BRAVE_API_KEY: process.env.BRAVE_API_KEY,
  SPIDER_API_KEY: process.env.SPIDER_API_KEY,
  ZAI_API_KEY: process.env.ZAI_API_KEY,
};

afterEach(async () => {
  resetVvocConfigForTests();
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function createProject(config: VvocConfig): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vvoc-web-tools-"));
  tempDirs.push(directory);
  await mkdir(join(directory, ".vvoc"), { recursive: true });
  await writeFile(join(directory, ".vvoc", "vvoc.json"), `${JSON.stringify(config, null, 2)}\n`);
  return directory;
}

function createPluginInput(directory: string, logs: Array<Record<string, unknown>>): PluginInput {
  return {
    client: {
      app: {
        log: async (input: { body?: Record<string, unknown> }) => {
          logs.push(input.body ?? {});
        },
      },
    } as never,
    project: {} as never,
    directory,
    worktree: directory,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  };
}

async function createPlugin(config: VvocConfig) {
  resetVvocConfigForTests();
  const directory = await createProject(config);
  const logs: Array<Record<string, unknown>> = [];
  const plugin = await WebToolsPlugin(createPluginInput(directory, logs));
  return { directory, logs, plugin };
}

function createToolContext(ask: ToolContext["ask"] = async () => undefined): ToolContext {
  return {
    sessionID: "session-1",
    messageID: "message-1",
    agent: "test-agent",
    directory: "/tmp/project",
    worktree: "/tmp/project",
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask,
  };
}

describe("applyBuiltinSuppression", () => {
  test("creates permission rules and denies both built-in web tools", () => {
    const config = {} as Config;
    applyBuiltinSuppression(config);
    expect(config.permission as Record<string, unknown>).toMatchObject({
      webfetch: "deny",
      websearch: "deny",
    });
  });

  test("leaves explicit user permission entries untouched", () => {
    const config = {
      permission: { webfetch: "allow", websearch: "ask", bash: "deny" },
    } as Config;
    applyBuiltinSuppression(config);
    expect(config.permission as Record<string, unknown>).toEqual({
      webfetch: "allow",
      websearch: "ask",
      bash: "deny",
    });
  });
});

describe("WebToolsPlugin", () => {
  test("returns empty hooks when web-tools is disabled", async () => {
    const config = createDefaultVvocConfig();
    config.plugins = { ...config.plugins, "web-tools": false };
    const { logs, plugin } = await createPlugin(config);

    expect(plugin).toEqual({});
    expect(logs).toEqual([]);
  });

  test("registers exactly web_search and web_fetch when enabled", async () => {
    const { plugin } = await createPlugin(createDefaultVvocConfig());
    expect(Object.keys(plugin.tool ?? {}).sort()).toEqual(["web_fetch", "web_search"]);

    const runtimeConfig = {} as Config;
    await plugin.config?.(runtimeConfig);
    expect(runtimeConfig.permission).toMatchObject({ webfetch: "deny", websearch: "deny" });
  });

  test("publishes strict input schemas for both owned tools and leaves others untouched", async () => {
    const { plugin } = await createPlugin(createDefaultVvocConfig());
    const definition = plugin["tool.definition"]!;

    const searchOutput: Record<string, unknown> = {
      description: "search",
      parameters: {},
      jsonSchema: {},
    };
    await definition({ toolID: "web_search" } as never, searchOutput as never);
    const searchSchema = searchOutput.jsonSchema as Record<string, unknown>;
    expect(searchSchema.additionalProperties).toBe(false);
    expect(Object.keys(searchSchema.properties as Record<string, unknown>).sort()).toEqual([
      "count",
      "freshness",
      "query",
    ]);

    const fetchOutput: Record<string, unknown> = {
      description: "fetch",
      parameters: {},
      jsonSchema: {},
    };
    await definition({ toolID: "web_fetch" } as never, fetchOutput as never);
    const fetchSchema = fetchOutput.jsonSchema as Record<string, unknown>;
    expect(fetchSchema.additionalProperties).toBe(false);
    expect(Object.keys(fetchSchema.properties as Record<string, unknown>).sort()).toEqual([
      "format",
      "timeout",
      "url",
    ]);

    // Unowned tool ids are never republished or rejected by the owned adapter.
    const otherOutput: Record<string, unknown> = {
      description: "other",
      parameters: { host: "decoder" },
      jsonSchema: { type: "object" },
    };
    await definition({ toolID: "bash" } as never, otherOutput as never);
    expect(otherOutput.jsonSchema).toEqual({ type: "object" });
  });

  test("tool.execute.before rejects invalid owned arguments before any permission or dispatch", async () => {
    const { plugin } = await createPlugin(createDefaultVvocConfig());
    const before = plugin["tool.execute.before"]!;
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("unexpected");
    }) as unknown as typeof fetch;
    try {
      const invalidCalls: Array<{ tool: string; args: Record<string, unknown> }> = [
        { tool: "web_search", args: { query: "vvoc", count: 0 } },
        { tool: "web_search", args: { query: "vvoc", apiKey: "never-print-this" } },
        { tool: "web_fetch", args: { url: "file:///tmp/secret" } },
        { tool: "web_fetch", args: { url: "https://example.test/page", timeout: 0 } },
        { tool: "web_fetch", args: { url: "https://example.test/page", credential: "secret" } },
      ];
      for (const call of invalidCalls) {
        await expect(
          before(
            { tool: call.tool, sessionID: "session-1", callID: "c1" } as never,
            { args: call.args } as never,
          ),
        ).rejects.toBeInstanceOf(ContractInputError);
      }
      expect(fetched).toBe(false);

      // Unrelated host or MCP tools are never intercepted.
      await expect(
        before(
          { tool: "bash", sessionID: "session-1", callID: "c2" } as never,
          { args: { command: "echo hi" } } as never,
        ),
      ).resolves.toBeUndefined();
      await expect(
        before(
          { tool: "some_mcp_tool", sessionID: "session-1", callID: "c3" } as never,
          { args: {} } as never,
        ),
      ).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("direct owned execute rejects invalid arguments without a permission prompt or fetch", async () => {
    const { plugin } = await createPlugin(createDefaultVvocConfig());
    const originalFetch = globalThis.fetch;
    let fetched = false;
    let asked = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("unexpected");
    }) as unknown as typeof fetch;
    try {
      const context = createToolContext(async () => {
        asked = true;
      });
      await expect(
        plugin.tool!.web_search.execute({ query: "vvoc", count: 0 } as never, context as never),
      ).rejects.toBeInstanceOf(ContractInputError);
      await expect(
        plugin.tool!.web_fetch.execute({ url: "ftp://example.test/x" } as never, context as never),
      ).rejects.toBeInstanceOf(ContractInputError);
      expect(asked).toBe(false);
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("logs provider names and credential sources without credential values", async () => {
    process.env.BRAVE_API_KEY = "environment-brave-secret";
    const config = createDefaultVvocConfig();
    config.web = {
      search: { provider: "brave", apiKey: "config-brave-secret" },
      fetch: { provider: "spider", apiKey: "config-spider-secret" },
    };
    const { logs } = await createPlugin(config);
    const serialized = JSON.stringify(logs);

    expect(logs[0]).toMatchObject({
      service: "web-tools",
      level: "info",
      extra: {
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
    const { logs } = await createPlugin(config);
    const serialized = JSON.stringify(logs);

    expect(logs[0]).toMatchObject({
      service: "web-tools",
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

  test("warns when a project apiKey config is tracked without logging its value", async () => {
    const config = createDefaultVvocConfig();
    config.web = { search: { provider: "exa", apiKey: "tracked-project-secret" } };
    resetVvocConfigForTests();
    const directory = await createProject(config);
    Bun.spawnSync(["git", "init", "-q"], { cwd: directory });
    Bun.spawnSync(["git", "add", "-f", ".vvoc/vvoc.json"], { cwd: directory });
    const logs: Array<Record<string, unknown>> = [];

    await WebToolsPlugin(createPluginInput(directory, logs));
    const serialized = JSON.stringify(logs);
    expect(serialized).toContain("vvoc.json");
    expect(serialized).toContain("tracked by git");
    expect(serialized).not.toContain("tracked-project-secret");
  });
});
