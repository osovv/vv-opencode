// FILE: src/plugins/web-tools.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify WebToolsPlugin toggle behavior, canonical tool registration, runtime built-in suppression, diagnostics, and tracked-config warnings.
//   SCOPE: Plugin-level tests using isolated vvoc project configs and stubbed OpenCode logging.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/config-layers.ts, src/lib/vvoc-config.ts, src/plugins/web-tools/index.ts]
//   LINKS: [M-PLUGIN-WEB-TOOLS]
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
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial coverage for WebToolsPlugin registration, suppression, and credential-safe diagnostics.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, PluginInput } from "@opencode-ai/plugin";
import { resetVvocConfigForTests } from "../lib/config-layers.js";
import { createDefaultVvocConfig, type VvocConfig } from "../lib/vvoc-config.js";
import { applyBuiltinSuppression, WebToolsPlugin } from "./web-tools/index.js";

const tempDirs: string[] = [];
const ORIGINAL_ENV = {
  EXA_API_KEY: process.env.EXA_API_KEY,
  BRAVE_API_KEY: process.env.BRAVE_API_KEY,
  SPIDER_API_KEY: process.env.SPIDER_API_KEY,
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
