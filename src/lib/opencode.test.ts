// FILE: src/lib/opencode.test.ts
// VERSION: 1.1.1
// START_MODULE_CONTRACT
//   PURPOSE: Verify OpenCode config mutation and canonical vvoc config path/helpers.
//   SCOPE: Plugin specifier writes, role-reference OpenCode defaults/agent rewrites, managed prompt scaffolding, canonical vvoc schema v3 writes, strict pre-role schema rejection, and scope-aware path resolution behavior.
//   INPUTS: Helper return values, temp config homes, and representative OpenCode/vvoc config documents.
//   OUTPUTS: Assertions over rewritten config text, persisted files, and scope-aware paths.
//   DEPENDS: [bun:test, jsonc-parser, src/lib/opencode.ts]
//   LINKS: [V-M-CLI-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ensurePackageConfigText tests - Verify schema insertion and pinned plugin writes.
//   ensureManagedAgentRegistrationsConfigText tests - Verify role-reference defaults and managed agent rewrites while preserving comments.
//   canonical vvoc config tests - Verify schema v3 seeding, managed preset refresh, and strict pre-role rejection.
//   provider helper tests - Verify conservative provider patch helpers remain comment-safe.
//   resolvePaths tests - Verify vvoc/OpenCode root separation by scope.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.1 - Updated managed registration coverage so only `agent.explore` is auto-seeded among built-in OpenCode agents.]
//   LAST_CHANGE: [v1.1.0 - Added installation inspection coverage for canonical role inventory ordering and unresolved vv-role reference diagnostics.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import {
  OPENCODE_SCHEMA_URL,
  PACKAGE_NAME,
  ensureManagedAgentRegistrationsConfigText,
  ensurePackageConfigText,
  ensurePackageInstalled,
  ensureProviderBaseUrlConfigText,
  installManagedAgentPrompts,
  installVvocConfig,
  inspectInstallation,
  parseGuardianConfigText,
  readVvocConfig,
  renderGuardianConfig,
  resolvePaths,
  syncManagedAgentRegistrations,
  syncVvocConfig,
  writeGuardianConfig,
  writeMemoryConfig,
  writeProviderBaseUrl,
  writeOpenCodeProviderObject,
} from "./opencode.js";
import {
  createDefaultVvocConfig,
  renderVvocConfig,
  VVOC_CONFIG_SCHEMA_URL,
} from "./vvoc-config.js";

describe("ensurePackageConfigText", () => {
  test("creates a new config when none exists", () => {
    const output = ensurePackageConfigText(undefined, `${PACKAGE_NAME}@0.2.3`);
    const parsed = parse(output) as { $schema?: string; plugin?: string[] };

    expect(parsed.$schema).toBe(OPENCODE_SCHEMA_URL);
    expect(parsed.plugin).toEqual([`${PACKAGE_NAME}@0.2.3`]);
  });

  test("preserves comments while appending the plugin", () => {
    const input = `{
  // existing plugin comment
  "plugin": ["foo"]
}\n`;
    const output = ensurePackageConfigText(input, `${PACKAGE_NAME}@0.2.3`);
    const parsed = parse(output) as { plugin?: string[] };

    expect(output).toContain("// existing plugin comment");
    expect(parsed.plugin).toEqual(["foo", `${PACKAGE_NAME}@0.2.3`]);
  });

  test("upgrades bare or old pinned package entries to the requested version", () => {
    const input = `{
  "plugin": ["foo", "${PACKAGE_NAME}", "${PACKAGE_NAME}@0.2.2"]
}\n`;
    const output = ensurePackageConfigText(input, `${PACKAGE_NAME}@0.2.3`);
    const parsed = parse(output) as { plugin?: string[] };

    expect(parsed.plugin).toEqual(["foo", `${PACKAGE_NAME}@0.2.3`]);
  });
});

describe("guardian config helpers", () => {
  test("round-trips managed guardian config values", () => {
    const output = renderGuardianConfig({
      timeoutMs: 12_345,
      approvalRiskThreshold: 55,
      reviewToastDurationMs: 6_789,
    });
    const parsed = parseGuardianConfigText(output, "test guardian config");

    expect(parsed).toEqual({
      timeoutMs: 12_345,
      approvalRiskThreshold: 55,
      reviewToastDurationMs: 6_789,
    });
  });
});

describe("managed OpenCode role-reference rewrites", () => {
  test("rewrites root defaults, built-in agents, and managed agents to vv-role refs", async () => {
    const paths = await resolvePaths({
      scope: "global",
      cwd: "/workspace/project",
      configDir: "/tmp/vvoc-config-home",
    });

    const output = ensureManagedAgentRegistrationsConfigText(undefined, paths);
    const parsed = parse(output) as {
      model?: string;
      small_model?: string;
      agent?: Record<
        string,
        { model?: string; prompt?: string; mode?: string; permission?: unknown }
      >;
    };

    expect(parsed.model).toBe("vv-role:default");
    expect(parsed.small_model).toBe("vv-role:fast");
    expect(parsed.agent?.build).toBeUndefined();
    expect(parsed.agent?.plan).toBeUndefined();
    expect(parsed.agent?.general).toBeUndefined();
    expect(parsed.agent?.explore?.model).toBe("vv-role:fast");
    expect(parsed.agent?.enhancer?.model).toBe("vv-role:smart");
    expect(parsed.agent?.enhancer?.mode).toBe("primary");
    expect(parsed.agent?.enhancer?.prompt).toBe("{file:../vvoc/agents/enhancer.md}");
    expect(parsed.agent?.enhancer?.permission).toEqual({
      edit: "deny",
      bash: "deny",
      task: "deny",
      todowrite: "deny",
    });
    expect(parsed.agent?.implementer?.model).toBe("vv-role:default");
    expect(parsed.agent?.["spec-reviewer"]?.model).toBe("vv-role:smart");
    expect(parsed.agent?.["code-reviewer"]?.model).toBe("vv-role:smart");
    expect(parsed.agent?.investitagor?.model).toBe("vv-role:smart");
  });

  test("preserves comments while rewriting managed fields and leaving unrelated built-ins alone", async () => {
    const paths = await resolvePaths({
      scope: "project",
      cwd: "/workspace/project",
      configDir: "/tmp/vvoc-config-home",
    });

    const input = `{
  // keep root note
  "model": "openai/gpt-5",
  // keep root small note
  "small_model": "openai/gpt-5-mini",
  "agent": {
    // keep managed note
    "enhancer": {
      // keep managed nested note
      "model": "openai/gpt-5",
      "prompt": "{file:./.vvoc/agents/enhancer.md}"
    },
    "build": {
      // keep build note
      "model": "openai/gpt-5",
      // keep build sibling note
      "mode": "primary"
    }
  }
}\n`;

    const output = ensureManagedAgentRegistrationsConfigText(input, paths);
    const parsed = parse(output) as {
      model?: string;
      small_model?: string;
      agent?: Record<string, { model?: string; prompt?: string }>;
    };

    expect(output).toContain("// keep root note");
    expect(output).toContain("// keep root small note");
    expect(output).toContain("// keep managed note");
    expect(output).toContain("// keep managed nested note");
    expect(output).toContain("// keep build note");
    expect(output).toContain("// keep build sibling note");
    expect(parsed.model).toBe("vv-role:default");
    expect(parsed.small_model).toBe("vv-role:fast");
    expect(parsed.agent?.build?.model).toBe("openai/gpt-5");
    expect(parsed.agent?.enhancer?.model).toBe("vv-role:smart");
    expect(parsed.agent?.enhancer?.prompt).toBe("{file:.vvoc/agents/enhancer.md}");
  });
});

describe("canonical vvoc config helpers", () => {
  test("ships a versioned schema file at the canonical hosted URL", async () => {
    const schemaText = await readFile(
      new URL("../../schemas/vvoc/v3.json", import.meta.url),
      "utf8",
    );
    const schema = JSON.parse(schemaText) as {
      $id?: string;
      properties?: { version?: { const?: number } };
    };

    expect(schema.$id).toBe(VVOC_CONFIG_SCHEMA_URL);
    expect(schema.properties?.version?.const).toBe(3);
  });

  test("fresh install creates schema v3 vvoc config and pins package in plugin array", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-fresh-install-v3-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });

      const pluginResult = await ensurePackageInstalled(paths);
      const registrationResult = await syncManagedAgentRegistrations(paths);
      const vvocResult = await installVvocConfig(paths);

      expect(pluginResult.changed).toBe(true);
      expect(registrationResult.changed).toBe(true);
      expect(vvocResult.action).toBe("created");

      const openCodeConfig = parse(await readFile(paths.opencodeConfigPath, "utf8")) as {
        plugin?: string[];
        model?: string;
        small_model?: string;
        agent?: Record<string, { model?: string }>;
      };
      const vvocConfig = await readVvocConfig(paths);

      expect(openCodeConfig.plugin?.some((entry) => entry.startsWith(`${PACKAGE_NAME}@`))).toBe(
        true,
      );
      expect(openCodeConfig.model).toBe("vv-role:default");
      expect(openCodeConfig.small_model).toBe("vv-role:fast");
      expect(openCodeConfig.agent?.build).toBeUndefined();
      expect(openCodeConfig.agent?.general).toBeUndefined();
      expect(openCodeConfig.agent?.explore?.model).toBe("vv-role:fast");
      expect(openCodeConfig.agent?.enhancer?.model).toBe("vv-role:smart");

      expect(vvocConfig?.version).toBe(3);
      expect(vvocConfig?.$schema).toBe(VVOC_CONFIG_SCHEMA_URL);
      expect(vvocConfig?.roles.default).toBeDefined();
      expect(vvocConfig?.roles.smart).toBeDefined();
      expect(vvocConfig?.roles.fast).toBeDefined();
      expect(vvocConfig?.roles.vision).toBeDefined();
      expect(Object.keys(vvocConfig?.presets ?? {})).toEqual(["vv-openai", "vv-zai", "vv-minimax"]);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("canonical writes preserve unrelated sections and refresh managed vv presets", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-v3-preset-refresh-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });

      await mkdir(join(configHome, "vvoc"), { recursive: true });
      await writeFile(
        paths.vvocConfigPath,
        JSON.stringify(
          {
            ...createDefaultVvocConfig(),
            roles: {
              ...createDefaultVvocConfig().roles,
              custom: "openai/gpt-5.4-mini",
            },
            presets: {
              "vv-zai": {
                description: "user drifted managed preset",
                agents: {
                  default: "openai/gpt-5",
                },
              },
              custom: {
                description: "user preset",
                agents: {
                  custom: "openai/gpt-5.4-mini",
                },
              },
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      await writeMemoryConfig(
        paths,
        {
          enabled: false,
          defaultSearchLimit: 12,
          reviewerModel: "openai/gpt-5.4-mini",
          reviewerVariant: "medium",
        },
        { merge: true },
      );
      await writeGuardianConfig(
        paths,
        {
          model: "openai/gpt-5.4",
          variant: "high",
          timeoutMs: 12_345,
        },
        { merge: true },
      );

      const syncResult = await syncVvocConfig(paths);
      expect(["updated", "kept"]).toContain(syncResult.action);

      const synced = await readVvocConfig(paths);
      expect(synced?.memory.enabled).toBe(false);
      expect(synced?.memory.defaultSearchLimit).toBe(12);
      expect(synced?.memory.reviewerModel).toBe("openai/gpt-5.4-mini");
      expect(synced?.memory.reviewerVariant).toBe("medium");
      expect(synced?.guardian.model).toBe("openai/gpt-5.4");
      expect(synced?.guardian.variant).toBe("high");
      expect(synced?.guardian.timeoutMs).toBe(12_345);
      expect(synced?.roles.custom).toBe("openai/gpt-5.4-mini");
      expect(synced?.presets.custom?.agents.custom).toBe("openai/gpt-5.4-mini");
      expect(synced?.presets["vv-zai"]?.agents.default).toBe("zai-coding-plan/glm-5.1");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("strict reads and sync reject unsupported pre-role vvoc schemas", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-v2-reject-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await mkdir(join(configHome, "vvoc"), { recursive: true });

      await writeFile(
        paths.vvocConfigPath,
        JSON.stringify(
          {
            $schema: "https://cdn.jsdelivr.net/npm/@osovv/vv-opencode@0.21.1/schemas/vvoc/v2.json",
            version: 2,
            guardian: {
              timeoutMs: 12345,
              approvalRiskThreshold: 70,
              reviewToastDurationMs: 54321,
            },
            memory: {
              enabled: false,
              defaultSearchLimit: 12,
            },
            secretsRedaction: createDefaultVvocConfig().secretsRedaction,
            presets: createDefaultVvocConfig().presets,
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      await expect(readVvocConfig(paths)).rejects.toThrow(/version|roles/);
      await expect(syncVvocConfig(paths)).rejects.toThrow(/version|roles/);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});

describe("managed prompt install", () => {
  test("writes managed prompt files and keeps project-scope prompt refs", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-managed-agents-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
      });

      const promptResults = await installManagedAgentPrompts(paths, { force: true });
      expect(promptResults).toHaveLength(7);

      const openCode = ensureManagedAgentRegistrationsConfigText(undefined, paths);
      const parsed = parse(openCode) as { agent?: Record<string, { prompt?: string }> };
      expect(parsed.agent?.enhancer?.prompt).toBe("{file:.vvoc/agents/enhancer.md}");
      expect(parsed.agent?.implementer?.prompt).toBe("{file:.vvoc/agents/implementer.md}");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("provider baseURL helpers", () => {
  test("creates a new config with a provider baseURL override", () => {
    const output = ensureProviderBaseUrlConfigText(
      undefined,
      "stepfun",
      "https://api.stepfun.ai/v1",
    );
    const parsed = parse(output) as {
      $schema?: string;
      provider?: Record<string, { options?: { baseURL?: string } }>;
    };

    expect(parsed.$schema).toBe(OPENCODE_SCHEMA_URL);
    expect(parsed.provider?.stepfun?.options?.baseURL).toBe("https://api.stepfun.ai/v1");
  });

  test("preserves comments while patching provider baseURL", () => {
    const input = `{
  // keep provider docs
  "provider": {
    "stepfun": {
      "options": {
        // keep timeout
        "timeout": 1000
      }
    }
  }
}\n`;
    const output = ensureProviderBaseUrlConfigText(input, "stepfun", "https://api.stepfun.ai/v1");
    const parsed = parse(output) as {
      provider?: Record<string, { options?: { baseURL?: string; timeout?: number } }>;
    };

    expect(output).toContain("// keep provider docs");
    expect(output).toContain("// keep timeout");
    expect(parsed.provider?.stepfun?.options?.timeout).toBe(1000);
    expect(parsed.provider?.stepfun?.options?.baseURL).toBe("https://api.stepfun.ai/v1");
  });

  test("writes provider override idempotently", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-provider-patch-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });

      const first = await writeProviderBaseUrl(paths, "stepfun", "https://api.stepfun.ai/v1");
      const second = await writeProviderBaseUrl(paths, "stepfun", "https://api.stepfun.ai/v1");
      const content = await readFile(paths.opencodeConfigPath, "utf8");
      const parsed = parse(content) as {
        provider?: Record<string, { options?: { baseURL?: string } }>;
      };

      expect(first.action).toBe("created");
      expect(second.action).toBe("kept");
      expect(parsed.provider?.stepfun?.options?.baseURL).toBe("https://api.stepfun.ai/v1");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});

describe("provider object helpers", () => {
  test("merges provider-specific object patches without clobbering sibling models", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-opencode-provider-object-"));
    const zaiPatch = {
      models: {
        "glm-4.5-airx": {
          "name: glm-4.5-airx": {
            limit: {
              context: 128000,
              output: 96000,
            },
          },
        },
      },
    };

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });

      await mkdir(join(configHome, "opencode"), { recursive: true });

      await writeFile(
        paths.opencodeConfigPath,
        JSON.stringify(
          {
            $schema: OPENCODE_SCHEMA_URL,
            provider: {
              "zai-coding-plan": {
                models: {
                  Existing: {
                    name: "Existing",
                  },
                },
              },
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const first = await writeOpenCodeProviderObject(paths, "zai-coding-plan", zaiPatch);
      const second = await writeOpenCodeProviderObject(paths, "zai-coding-plan", zaiPatch);
      const content = await readFile(paths.opencodeConfigPath, "utf8");
      const parsed = JSON.parse(content) as {
        provider?: Record<string, { models?: Record<string, Record<string, unknown>> }>;
      };

      expect(first.action).toBe("updated");
      expect(second.action).toBe("kept");
      expect(parsed.provider?.["zai-coding-plan"]?.models?.Existing).toEqual({
        name: "Existing",
      });
      expect(parsed.provider?.["zai-coding-plan"]?.models?.["glm-4.5-airx"]).toEqual({
        "name: glm-4.5-airx": {
          limit: {
            context: 128000,
            output: 96000,
          },
        },
      });
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});

describe("resolvePaths", () => {
  test("separates global opencode and vvoc config roots", async () => {
    const paths = await resolvePaths({
      scope: "global",
      cwd: "/workspace/project",
      configDir: "/tmp/vvoc-config-home",
    });

    expect(paths.configHome).toBe("/tmp/vvoc-config-home");
    expect(paths.opencodeBaseDir).toBe("/tmp/vvoc-config-home/opencode");
    expect(paths.vvocBaseDir).toBe("/tmp/vvoc-config-home/vvoc");
    expect(paths.vvocConfigPath).toBe("/tmp/vvoc-config-home/vvoc/vvoc.json");
    expect(paths.managedAgentsDirPath).toBe("/tmp/vvoc-config-home/vvoc/agents");
    expect(paths.opencodeConfigPath).toBe("/tmp/vvoc-config-home/opencode/opencode.json");
  });

  test("keeps project prompts in .vvoc but canonical config global", async () => {
    const paths = await resolvePaths({
      scope: "project",
      cwd: "/workspace/project",
      configDir: "/tmp/vvoc-config-home",
    });

    expect(paths.opencodeBaseDir).toBe("/workspace/project");
    expect(paths.vvocBaseDir).toBe("/tmp/vvoc-config-home/vvoc");
    expect(paths.vvocConfigPath).toBe("/tmp/vvoc-config-home/vvoc/vvoc.json");
    expect(paths.managedAgentsDirPath).toBe("/workspace/project/.vvoc/agents");
  });
});

describe("inspectInstallation", () => {
  test("reports canonical role inventory and unresolved vv-role references", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-install-inspect-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-install-inspect-project-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
        configDir: configHome,
      });

      await mkdir(join(configHome, "vvoc"), { recursive: true });

      await writeFile(
        paths.vvocConfigPath,
        renderVvocConfig({
          ...createDefaultVvocConfig(),
          roles: {
            ...createDefaultVvocConfig().roles,
            custom: "openai/gpt-5.4-mini",
          },
        }),
        "utf8",
      );

      await writeFile(
        paths.opencodeConfigPath,
        JSON.stringify(
          {
            $schema: OPENCODE_SCHEMA_URL,
            plugin: [PACKAGE_NAME],
            model: "vv-role:missing",
            small_model: "vv-role:fast",
            agent: {
              general: {
                model: "vv-role:default",
              },
            },
            command: {
              plan: {
                model: "vv-role:another-missing",
              },
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const inspection = await inspectInstallation(paths);

      expect(inspection.roles.assignments.map((entry) => entry.roleId)).toEqual([
        "default",
        "smart",
        "fast",
        "vision",
        "custom",
      ]);
      expect(inspection.roles.unresolvedReferences).toEqual([
        {
          fieldPath: "model",
          roleRef: "vv-role:missing",
          roleId: "missing",
        },
        {
          fieldPath: "command.plan.model",
          roleRef: "vv-role:another-missing",
          roleId: "another-missing",
        },
      ]);
      expect(inspection.problems).toContain(
        "unresolved role reference at model: vv-role:missing (missing role: missing)",
      );
      expect(inspection.problems).toContain(
        "unresolved role reference at command.plan.model: vv-role:another-missing (missing role: another-missing)",
      );
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
