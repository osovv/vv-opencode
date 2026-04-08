// FILE: src/lib/opencode.test.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify OpenCode config mutation and vvoc config path helpers.
//   SCOPE: Plugin specifier writes, provider baseURL patching, managed OpenCode command registration, OpenCode agent model overrides, managed subagent registration/prompt scaffolding, Guardian config round-trips, and path resolution behavior.
//   DEPENDS: [bun:test, jsonc-parser, src/lib/opencode.ts]
//   LINKS: [V-M-CLI-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ensurePackageConfigText tests - Verify schema insertion and pinned plugin writes.
//   provider baseURL helper tests - Verify conservative provider.options.baseURL patching.
//   managed command config helpers tests - Verify /enhance registration with a structured XML template and conservative merge behavior.
//   built-in OpenCode agent model helper tests - Verify general/explore model overrides round-trip through OpenCode config.
//   managed subagent config helpers tests - Verify registration, prompt scaffolding, and model override round-trips.
//   guardian config helpers tests - Verify Guardian config render/parse round-trips.
//   resolvePaths tests - Verify vvoc/OpenCode root separation by scope.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.3.0 - Added verification for the managed /enhance OpenCode command registration.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import {
  OPENCODE_SCHEMA_URL,
  PACKAGE_NAME,
  ensureManagedCommandsConfigText,
  ensurePackageConfigText,
  ensureProviderBaseUrlConfigText,
  ensureManagedSubagentsConfigText,
  installManagedAgentPrompts,
  parseGuardianConfigText,
  readOpenCodeAgentModel,
  readManagedSubagentModels,
  renderGuardianConfig,
  resolvePaths,
  writeOpenCodeAgentModel,
  writeProviderBaseUrl,
  writeManagedSubagentModel,
} from "./opencode.js";

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

describe("managed command config helpers", () => {
  test("creates the managed /enhance command with a structured XML template", () => {
    const output = ensureManagedCommandsConfigText(undefined);
    const parsed = parse(output) as {
      $schema?: string;
      command?: Record<string, { description?: string; template?: string }>;
    };

    expect(parsed.$schema).toBe(OPENCODE_SCHEMA_URL);
    expect(parsed.command?.enhance?.description).toBe(
      "Wrap a raw request in vvoc's structured XML execution prompt.",
    );
    expect(parsed.command?.enhance?.template).toContain('<vvoc_enhance version="1.0">');
    expect(parsed.command?.enhance?.template).toContain("<![CDATA[$ARGUMENTS]]>");
  });

  test("preserves existing /enhance overrides while backfilling managed metadata", () => {
    const input = `{
  // keep custom command docs
  "command": {
    "enhance": {
      "template": "custom template"
    }
  }
}\n`;
    const output = ensureManagedCommandsConfigText(input);
    const parsed = parse(output) as {
      command?: Record<string, { description?: string; template?: string }>;
    };

    expect(output).toContain("// keep custom command docs");
    expect(parsed.command?.enhance?.template).toBe("custom template");
    expect(parsed.command?.enhance?.description).toBe(
      "Wrap a raw request in vvoc's structured XML execution prompt.",
    );
  });
});

describe("managed subagent config helpers", () => {
  test("creates managed subagent registrations with vvoc prompt refs", async () => {
    const paths = await resolvePaths({
      scope: "global",
      cwd: "/workspace/project",
      configDir: "/tmp/vvoc-config-home",
    });

    const output = ensureManagedSubagentsConfigText(undefined, paths);
    const parsed = parse(output) as {
      $schema?: string;
      agent?: Record<
        string,
        { mode?: string; prompt?: string; permission?: Record<string, unknown>; steps?: number }
      >;
    };

    expect(parsed.$schema).toBe(OPENCODE_SCHEMA_URL);
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
      expect(promptResults).toHaveLength(6);

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
      expect(guardianPrompt).toContain("risk assessment of a coding-agent tool call");
      expect(memoryReviewerPrompt).toContain(
        "You review explicit persistent memory managed by vvoc.",
      );

      const setResult = await writeManagedSubagentModel(paths, "implementer", {
        model: "openai/gpt-5",
        ensureEntry: true,
      });
      expect(setResult.action).toBe("created");

      const models = await readManagedSubagentModels(paths);
      expect(models.implementer).toBe("openai/gpt-5");

      const unsetResult = await writeManagedSubagentModel(paths, "implementer", {
        ensureEntry: false,
      });
      expect(unsetResult.action).toBe("updated");

      const modelsAfterUnset = await readManagedSubagentModels(paths);
      expect(modelsAfterUnset.implementer).toBeUndefined();
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
    expect(paths.managedAgentsDirPath).toBe("/tmp/vvoc-config-home/vvoc/agents");
    expect(paths.opencodeConfigPath).toBe("/tmp/vvoc-config-home/opencode/opencode.json");
    expect(paths.guardianConfigPath).toBe("/tmp/vvoc-config-home/vvoc/guardian.jsonc");
    expect(paths.memoryConfigPath).toBe("/tmp/vvoc-config-home/vvoc/memory.jsonc");
  });

  test("uses .vvoc for project-scoped vvoc config", async () => {
    const paths = await resolvePaths({
      scope: "project",
      cwd: "/workspace/project",
    });

    expect(paths.opencodeBaseDir).toBe("/workspace/project");
    expect(paths.vvocBaseDir).toBe("/workspace/project/.vvoc");
    expect(paths.managedAgentsDirPath).toBe("/workspace/project/.vvoc/agents");
    expect(paths.guardianConfigPath).toBe("/workspace/project/.vvoc/guardian.jsonc");
    expect(paths.memoryConfigPath).toBe("/workspace/project/.vvoc/memory.jsonc");
  });
});
