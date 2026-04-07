// FILE: src/lib/opencode.test.ts
// VERSION: 0.2.6
// START_MODULE_CONTRACT
//   PURPOSE: Verify OpenCode config mutation and vvoc config path helpers.
//   SCOPE: Plugin specifier writes, managed subagent registration/prompt scaffolding, Guardian config round-trips, and path resolution behavior.
//   DEPENDS: [bun:test, jsonc-parser, src/lib/opencode.ts]
//   LINKS: [V-M-CLI-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ensurePackageConfigText tests - Verify schema insertion and pinned plugin writes.
//   managed subagent config helpers tests - Verify registration, prompt scaffolding, and model override round-trips.
//   guardian config helpers tests - Verify Guardian config render/parse round-trips.
//   resolvePaths tests - Verify vvoc/OpenCode root separation by scope.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.6 - Added verification for managed subagent registration and prompt scaffolding.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import {
  OPENCODE_SCHEMA_URL,
  PACKAGE_NAME,
  ensurePackageConfigText,
  ensureManagedSubagentsConfigText,
  installManagedAgentPrompts,
  parseGuardianConfigText,
  readManagedSubagentModels,
  renderGuardianConfig,
  resolvePaths,
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
        { mode?: string; prompt?: string; permission?: Record<string, unknown> }
      >;
    };

    expect(parsed.$schema).toBe(OPENCODE_SCHEMA_URL);
    expect(parsed.agent?.implementer?.mode).toBe("subagent");
    expect(parsed.agent?.implementer?.prompt).toBe("{file:../vvoc/agents/implementer.md}");
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
