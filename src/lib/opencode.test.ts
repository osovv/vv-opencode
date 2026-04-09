// FILE: src/lib/opencode.test.ts
// VERSION: 0.8.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify OpenCode config mutation and canonical vvoc config path/helpers.
//   SCOPE: Plugin specifier writes, top-level OpenCode model writes, provider baseURL patching, managed OpenCode agent registration/prompt scaffolding, canonical vvoc config writes and migration, OpenCode agent model overrides, Guardian section round-trips, and path resolution behavior.
//   DEPENDS: [bun:test, jsonc-parser, src/lib/opencode.ts]
//   LINKS: [V-M-CLI-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ensurePackageConfigText tests - Verify schema insertion and pinned plugin writes.
//   provider baseURL helper tests - Verify conservative provider.options.baseURL patching.
//   built-in OpenCode agent model helper tests - Verify general/explore model overrides round-trip through OpenCode config.
//   top-level OpenCode model helper tests - Verify default model and small_model overrides round-trip through OpenCode config.
//   managed agent registration helpers tests - Verify primary/subagent registration, prompt scaffolding, and model override round-trips.
//   guardian config helpers tests - Verify Guardian config render/parse round-trips.
//   resolvePaths tests - Verify vvoc/OpenCode root separation by scope.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.8.0 - Added coverage for OpenCode top-level model and small_model writes.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import {
  OPENCODE_SCHEMA_URL,
  PACKAGE_NAME,
  ensurePackageConfigText,
  ensureProviderBaseUrlConfigText,
  ensureManagedAgentRegistrationsConfigText,
  installVvocConfig,
  installManagedAgentPrompts,
  parseGuardianConfigText,
  readOpenCodeDefaultModel,
  readVvocConfig,
  readOpenCodeAgentModel,
  readManagedAgentModels,
  renderGuardianConfig,
  resolvePaths,
  syncVvocConfig,
  writeOpenCodeDefaultModel,
  writeGuardianConfig,
  writeMemoryConfig,
  writeOpenCodeAgentModel,
  writeProviderBaseUrl,
  writeManagedAgentModel,
} from "./opencode.js";
import { VVOC_CONFIG_SCHEMA_URL } from "./vvoc-config.js";

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
      model: "anthropic/claude-sonnet-4-5",
      variant: "high",
      timeoutMs: 12_345,
      approvalRiskThreshold: 55,
      reviewToastDurationMs: 6_789,
    });
    const parsed = parseGuardianConfigText(output, "test guardian config");

    expect(parsed).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      variant: "high",
      timeoutMs: 12_345,
      approvalRiskThreshold: 55,
      reviewToastDurationMs: 6_789,
    });
  });
});

describe("canonical vvoc config helpers", () => {
  test("ships a versioned schema file at the canonical hosted URL", async () => {
    const schemaText = await readFile(
      new URL("../../schemas/vvoc/v2.json", import.meta.url),
      "utf8",
    );
    const schema = JSON.parse(schemaText) as {
      $id?: string;
      properties?: { version?: { const?: number } };
    };

    expect(schema.$id).toBe(VVOC_CONFIG_SCHEMA_URL);
    expect(schema.properties?.version?.const).toBe(2);
  });

  test("installVvocConfig creates a fully seeded canonical config and preserves other sections", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-canonical-config-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: "/workspace/project",
        configDir: configHome,
      });

      const installResult = await installVvocConfig(paths);
      expect(installResult.action).toBe("created");

      const memoryResult = await writeMemoryConfig(paths, {
        enabled: false,
        defaultSearchLimit: 12,
      });
      expect(memoryResult.action).toBe("updated");

      const guardianResult = await writeGuardianConfig(
        paths,
        { model: "anthropic/claude-sonnet-4-5", variant: "high" },
        { merge: true },
      );
      expect(guardianResult.action).toBe("updated");

      const config = await readVvocConfig(paths);

      expect(config?.guardian.model).toBe("anthropic/claude-sonnet-4-5");
      expect(config?.guardian.variant).toBe("high");
      expect(config?.memory.enabled).toBe(false);
      expect(config?.memory.defaultSearchLimit).toBe(12);
      expect(config?.secretsRedaction.secret).toBe("${VVOC_SECRET}");
      expect(Object.keys(config?.presets ?? {})).toEqual(["openai", "zai", "minimax"]);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("readVvocConfig loads v1 docs and syncVvocConfig rewrites them to v2", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-v1-migration-"));

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
            $schema: "https://cdn.jsdelivr.net/npm/@osovv/vv-opencode@0.16.0/schemas/vvoc/v1.json",
            version: 1,
            guardian: {
              model: "anthropic/claude-sonnet-4-5",
              variant: "high",
              timeoutMs: 12345,
              approvalRiskThreshold: 70,
              reviewToastDurationMs: 54321,
            },
            memory: {
              enabled: false,
              defaultSearchLimit: 12,
              reviewerModel: "openai/gpt-5",
              reviewerVariant: "high",
            },
            secretsRedaction: {
              enabled: true,
              secret: "${VVOC_SECRET}",
              ttlMs: 60000,
              maxMappings: 77,
              patterns: {
                keywords: [],
                regex: [],
                builtin: ["email"],
                exclude: [],
              },
              debug: true,
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const loaded = await readVvocConfig(paths);
      expect(loaded?.guardian.timeoutMs).toBe(12345);
      expect(loaded?.memory.defaultSearchLimit).toBe(12);
      expect(Object.keys(loaded?.presets ?? {})).toEqual(["openai", "zai", "minimax"]);

      const syncResult = await syncVvocConfig(paths);
      expect(syncResult.action).toBe("updated");

      const rawText = await readFile(paths.vvocConfigPath, "utf8");
      const parsed = JSON.parse(rawText) as {
        version: number;
        guardian: {
          timeoutMs: number;
          approvalRiskThreshold: number;
          reviewToastDurationMs: number;
        };
        memory: { enabled: boolean; defaultSearchLimit: number };
        secretsRedaction: { ttlMs: number; maxMappings: number; debug: boolean };
        presets?: Record<string, unknown>;
      };

      expect(parsed.version).toBe(2);
      expect(parsed.guardian.timeoutMs).toBe(12345);
      expect(parsed.guardian.approvalRiskThreshold).toBe(70);
      expect(parsed.guardian.reviewToastDurationMs).toBe(54321);
      expect(parsed.memory.enabled).toBe(false);
      expect(parsed.memory.defaultSearchLimit).toBe(12);
      expect(parsed.secretsRedaction.ttlMs).toBe(60000);
      expect(parsed.secretsRedaction.maxMappings).toBe(77);
      expect(parsed.secretsRedaction.debug).toBe(true);
      expect(Object.keys(parsed.presets ?? {})).toEqual(["openai", "zai", "minimax"]);
    } finally {
      await rm(configHome, { recursive: true, force: true });
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

  test("rejects non-object provider options", () => {
    const input = `{
  "provider": {
    "stepfun": {
      "options": "bad"
    }
  }
}\n`;

    expect(() =>
      ensureProviderBaseUrlConfigText(input, "stepfun", "https://api.stepfun.ai/v1"),
    ).toThrow('OpenCode config: provider.stepfun: expected "options" to be an object');
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

describe("managed agent registration helpers", () => {
  test("creates managed agent registrations with vvoc prompt refs", async () => {
    const paths = await resolvePaths({
      scope: "global",
      cwd: "/workspace/project",
      configDir: "/tmp/vvoc-config-home",
    });

    const output = ensureManagedAgentRegistrationsConfigText(undefined, paths);
    const parsed = parse(output) as {
      $schema?: string;
      agent?: Record<
        string,
        { mode?: string; prompt?: string; permission?: Record<string, unknown>; steps?: number }
      >;
    };

    expect(parsed.$schema).toBe(OPENCODE_SCHEMA_URL);
    expect(parsed.agent?.enhancer?.mode).toBe("primary");
    expect(parsed.agent?.enhancer?.prompt).toBe("{file:../vvoc/agents/enhancer.md}");
    expect(parsed.agent?.enhancer?.permission).toEqual({
      edit: "deny",
      bash: "deny",
      task: "deny",
      todowrite: "deny",
    });
    expect(parsed.agent?.implementer?.mode).toBe("subagent");
    expect(parsed.agent?.implementer?.prompt).toBe("{file:../vvoc/agents/implementer.md}");
    expect(parsed.agent?.implementer?.steps).toBeUndefined();
    expect(parsed.agent?.["spec-reviewer"]?.permission).toEqual({ edit: "deny" });
    expect(parsed.agent?.investitagor?.prompt).toBe("{file:../vvoc/agents/investitagor.md}");
  });

  test("writes managed prompt files and round-trips model overrides", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-managed-agents-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
      });

      const promptResults = await installManagedAgentPrompts(paths, { force: true });
      expect(promptResults).toHaveLength(7);

      const enhancerPrompt = await readFile(
        join(projectDir, ".vvoc", "agents", "enhancer.md"),
        "utf8",
      );

      const implementerPrompt = await readFile(
        join(projectDir, ".vvoc", "agents", "implementer.md"),
        "utf8",
      );
      const guardianPrompt = await readFile(
        join(projectDir, ".vvoc", "agents", "guardian.md"),
        "utf8",
      );
      const memoryReviewerPrompt = await readFile(
        join(projectDir, ".vvoc", "agents", "memory-reviewer.md"),
        "utf8",
      );
      expect(implementerPrompt).toContain("Managed by vvoc");
      expect(implementerPrompt).not.toContain("mode: subagent");
      expect(implementerPrompt).not.toContain("steps:");
      expect(implementerPrompt).not.toStartWith("---\n");
      expect(implementerPrompt).toContain("You are the implementer subagent.");
      expect(enhancerPrompt).toContain("You are the enhancer agent.");
      expect(enhancerPrompt).toContain("<constraint-1>");
      expect(enhancerPrompt).toContain("<acceptance-criterion-1>");
      expect(guardianPrompt).toContain("risk assessment of a coding-agent tool call");
      expect(memoryReviewerPrompt).toContain(
        "You review explicit persistent memory managed by vvoc.",
      );

      const setResult = await writeManagedAgentModel(paths, "enhancer", {
        model: "openai/gpt-5",
        ensureEntry: true,
      });
      expect(setResult.action).toBe("created");

      const models = await readManagedAgentModels(paths);
      expect(models.enhancer).toBe("openai/gpt-5");

      const unsetResult = await writeManagedAgentModel(paths, "enhancer", {
        ensureEntry: false,
      });
      expect(unsetResult.action).toBe("updated");

      const modelsAfterUnset = await readManagedAgentModels(paths);
      expect(modelsAfterUnset.enhancer).toBeUndefined();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("built-in OpenCode agent model helpers", () => {
  test("writes and removes model overrides for general and explore", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-opencode-agent-model-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });

      const builtInAgents = ["general", "explore"] as const;

      for (const agentName of builtInAgents) {
        const setResult = await writeOpenCodeAgentModel(paths, agentName, {
          model: "openai/gpt-5-nano",
          ensureEntry: true,
        });
        const model = await readOpenCodeAgentModel(paths, agentName);

        expect(model).toBe("openai/gpt-5-nano");
        expect(["created", "updated"]).toContain(setResult.action);
      }

      for (const agentName of builtInAgents) {
        const unsetResult = await writeOpenCodeAgentModel(paths, agentName, {
          ensureEntry: false,
        });
        const modelAfterUnset = await readOpenCodeAgentModel(paths, agentName);

        expect(unsetResult.action).toBe("updated");
        expect(modelAfterUnset).toBeUndefined();
      }
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});

describe("top-level OpenCode model helpers", () => {
  test("writes and removes default model and small_model overrides", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-opencode-default-model-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });

      const defaultSetResult = await writeOpenCodeDefaultModel(paths, "model", {
        model: "openai/gpt-5",
        ensureEntry: true,
      });
      const smallSetResult = await writeOpenCodeDefaultModel(paths, "small_model", {
        model: "openai/gpt-5-mini",
        ensureEntry: true,
      });

      expect(["created", "updated"]).toContain(defaultSetResult.action);
      expect(["created", "updated"]).toContain(smallSetResult.action);
      expect(await readOpenCodeDefaultModel(paths, "model")).toBe("openai/gpt-5");
      expect(await readOpenCodeDefaultModel(paths, "small_model")).toBe("openai/gpt-5-mini");

      const content = await readFile(paths.opencodeConfigPath, "utf8");
      expect(content).toContain('"model": "openai/gpt-5"');
      expect(content).toContain('"small_model": "openai/gpt-5-mini"');

      const defaultUnsetResult = await writeOpenCodeDefaultModel(paths, "model", {
        ensureEntry: false,
      });
      const smallUnsetResult = await writeOpenCodeDefaultModel(paths, "small_model", {
        ensureEntry: false,
      });

      expect(defaultUnsetResult.action).toBe("updated");
      expect(smallUnsetResult.action).toBe("updated");
      expect(await readOpenCodeDefaultModel(paths, "model")).toBeUndefined();
      expect(await readOpenCodeDefaultModel(paths, "small_model")).toBeUndefined();
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
