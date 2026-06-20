// FILE: src/plugins/model-roles.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify ModelRolesPlugin role-reference resolution and explicit failure behavior.
//   SCOPE: Root and nested field resolution, literal passthrough behavior, and unknown failure paths with stable markers.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/config-layers.ts, src/lib/vvoc-config.ts, src/plugins/model-roles/index.ts]
//   LINKS: [M-PLUGIN-MODEL-ROLES, V-M-PLUGIN-MODEL-ROLES]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ModelRolesPlugin tests - Verify startup-time vv-role resolution for supported config targets and explicit failure surfaces.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.3.0 - Reset the runtime vvoc config singleton between isolated plugin fixtures.]
//   LAST_CHANGE: [v0.2.0 - Added effective runtime source precedence coverage for env and project-local vvoc config.]
//   LAST_CHANGE: [v0.1.0 - Added deterministic coverage for ModelRolesPlugin role resolution and failure semantics.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetVvocConfigForTests } from "../lib/config-layers.js";
import { createDefaultVvocConfig } from "../lib/vvoc-config.js";
import { ModelRolesPlugin } from "./model-roles/index.js";

const tempDirs: string[] = [];
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const previousVvocConfig = process.env.VVOC_CONFIG;

afterEach(async () => {
  resetVvocConfigForTests();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }

  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }

  if (previousVvocConfig === undefined) {
    delete process.env.VVOC_CONFIG;
  } else {
    process.env.VVOC_CONFIG = previousVvocConfig;
  }
});

async function createPluginWithRoles(overrides: Record<string, string>) {
  resetVvocConfigForTests();
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-model-roles-config-"));
  const projectDir = await mkdtemp(join(tmpdir(), "vvoc-model-roles-project-"));
  tempDirs.push(configHome, projectDir);
  process.env.XDG_CONFIG_HOME = configHome;

  const baseConfig = createDefaultVvocConfig();
  await mkdir(join(configHome, "vvoc"), { recursive: true });
  await writeFile(
    join(configHome, "vvoc", "vvoc.json"),
    JSON.stringify(
      {
        ...baseConfig,
        roles: {
          ...baseConfig.roles,
          ...overrides,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const logs: unknown[] = [];
  const plugin = await ModelRolesPlugin({
    client: {
      app: {
        log: async (payload: unknown) => {
          logs.push(payload);
        },
      },
    } as never,
    project: {} as never,
    directory: projectDir,
    worktree: projectDir,
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  });

  return { plugin, logs };
}

async function writeVvocConfig(
  rootDir: string,
  overrides: Record<string, string>,
): Promise<string> {
  await mkdir(join(rootDir, "vvoc"), { recursive: true });
  const configPath = join(rootDir, "vvoc", "vvoc.json");
  const baseConfig = createDefaultVvocConfig();
  await writeFile(
    configPath,
    JSON.stringify(
      {
        ...baseConfig,
        roles: {
          ...baseConfig.roles,
          ...overrides,
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return configPath;
}

async function createPluginInProject(projectDir: string) {
  resetVvocConfigForTests();
  const logs: unknown[] = [];
  const plugin = await ModelRolesPlugin({
    client: {
      app: {
        log: async (payload: unknown) => {
          logs.push(payload);
        },
      },
    } as never,
    project: {} as never,
    directory: projectDir,
    worktree: projectDir,
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  });
  return { plugin, logs };
}

function getLogMessages(logs: unknown[]): string[] {
  return logs
    .map((entry) => (entry as { body?: { message?: unknown } }).body?.message)
    .filter((value): value is string => typeof value === "string");
}

describe("ModelRolesPlugin", () => {
  test("resolves vv-role references in root model and small_model", async () => {
    const { plugin, logs } = await createPluginWithRoles({
      default: "openai/gpt-5.4",
      fast: "openai/gpt-5.4-mini",
    });

    const config: Record<string, any> = {
      model: "vv-role:default",
      small_model: "vv-role:fast",
    };

    await plugin.config?.(config as never);

    expect(config.model).toBe("openai/gpt-5.4");
    expect(config.small_model).toBe("openai/gpt-5.4-mini");

    const messages = getLogMessages(logs);
    expect(messages).toContain(
      "[model-roles][config][BLOCK_RESOLVE_CONFIG_ROLE_REFERENCES] role map loaded",
    );
    expect(messages).toContain(
      "[model-roles][config][BLOCK_RESOLVE_CONFIG_ROLE_REFERENCES] role reference resolved",
    );
  });

  test("resolves vv-role references in agent and command model fields", async () => {
    const { plugin } = await createPluginWithRoles({
      smart: "openai/gpt-5.4:xhigh",
      fast: "openai/gpt-5.4-mini",
    });

    const config: Record<string, any> = {
      agent: {
        build: { model: "vv-role:smart" },
        explore: { model: "vv-role:fast" },
      },
      command: {
        plan: { model: "vv-role:fast" },
      },
    };

    await plugin.config?.(config as never);

    expect(config.agent.build.model).toBe("openai/gpt-5.4:xhigh");

    expect(config.agent.explore.model).toBe("openai/gpt-5.4-mini");

    expect(config.command.plan.model).toBe("openai/gpt-5.4-mini");
  });

  test("prefers nearest project vvoc config over global config", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-model-roles-global-layer-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-model-roles-local-layer-"));
    tempDirs.push(configHome, projectDir);
    process.env.XDG_CONFIG_HOME = configHome;
    await writeVvocConfig(configHome, { default: "openai/global-model" });
    await mkdir(join(projectDir, ".vvoc"), { recursive: true });
    const localConfig = createDefaultVvocConfig();
    await writeFile(
      join(projectDir, ".vvoc", "vvoc.json"),
      JSON.stringify(
        { ...localConfig, roles: { ...localConfig.roles, default: "openai/local-model" } },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const { plugin } = await createPluginInProject(projectDir);
    const config: Record<string, any> = { model: "vv-role:default" };
    await plugin.config?.(config as never);

    expect(config.model).toBe("openai/local-model");
  });

  test("prefers VVOC_CONFIG over local and global config", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-model-roles-env-global-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-model-roles-env-project-"));
    const envDir = await mkdtemp(join(tmpdir(), "vvoc-model-roles-env-selected-"));
    tempDirs.push(configHome, projectDir, envDir);
    process.env.XDG_CONFIG_HOME = configHome;
    await writeVvocConfig(configHome, { default: "openai/global-model" });
    await mkdir(join(projectDir, ".vvoc"), { recursive: true });
    await writeFile(
      join(projectDir, ".vvoc", "vvoc.json"),
      JSON.stringify(
        {
          ...createDefaultVvocConfig(),
          roles: { ...createDefaultVvocConfig().roles, default: "openai/local-model" },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    process.env.VVOC_CONFIG = await writeVvocConfig(envDir, { default: "openai/env-model" });

    const { plugin } = await createPluginInProject(projectDir);
    const config: Record<string, any> = { model: "vv-role:default" };
    await plugin.config?.(config as never);

    expect(config.model).toBe("openai/env-model");
  });

  test("invalid local vvoc config fails fast instead of falling back to global", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-model-roles-invalid-global-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-model-roles-invalid-local-"));
    tempDirs.push(configHome, projectDir);
    process.env.XDG_CONFIG_HOME = configHome;
    await writeVvocConfig(configHome, { default: "openai/global-model" });
    await mkdir(join(projectDir, ".vvoc"), { recursive: true });
    await writeFile(join(projectDir, ".vvoc", "vvoc.json"), "{ invalid json", "utf8");

    await expect(createPluginInProject(projectDir)).rejects.toThrow(/failed to parse|invalid/i);
  });

  test("does not rewrite literal provider/model values that do not use vv-role syntax", async () => {
    const { plugin } = await createPluginWithRoles({
      default: "openai/gpt-5.4",
    });

    const config = {
      model: "openai/literal-root",
      small_model: "openai/literal-small",
      agent: {
        build: { model: "openai/literal-agent", variant: "high" },
      },
      command: {
        plan: { model: "openai/literal-command" },
      },
    };

    const before = JSON.parse(JSON.stringify(config));
    await plugin.config?.(config as never);
    expect(config).toEqual(before);
  });

  test("throws explicit unknown-role errors with field path and marker", async () => {
    const { plugin, logs } = await createPluginWithRoles({
      default: "openai/gpt-5.4",
    });

    const config = {
      agent: {
        build: { model: "vv-role:missing" },
      },
    };

    let thrown: unknown;
    try {
      await plugin.config?.(config as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect((thrown as Error).message).toContain("UNKNOWN_ROLE");
    expect((thrown as Error).message).toContain("agent.build.model");

    const messages = getLogMessages(logs);
    expect(messages).toContain(
      "[model-roles][config][BLOCK_RESOLVE_CONFIG_ROLE_REFERENCES] unknown role reference",
    );
  });
});
