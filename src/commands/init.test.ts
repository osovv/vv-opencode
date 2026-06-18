// FILE: src/commands/init.test.ts
// VERSION: 0.9.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-INIT - interactive project initialization.
//   SCOPE: Non-interactive init path, local project config layers, managed agent/skill/plan scaffolding, canonical config scaffolding, global side-effect guards, and idempotent re-run handling.
//   DEPENDS: [src/commands/init.ts]
//   LINKS: [M-CLI-INIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Test suite for init command.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.9.0 - Added project-local .opencode/.vvoc assertions and global side-effect guards for scoped init.]
//   LAST_CHANGE: [v0.10.0 - Updated init expectations for reviewer and orchestrator role bindings.]
//   LAST_CHANGE: [v0.8.1 - Updated init expectations so the managed vv-controller agent is seeded with the built-in smart role.]
//   LAST_CHANGE: [v0.8.1 - Removed vv-plan/vv-review command assertions after replacing them with managed skills system.]
//   LAST_CHANGE: [v0.8.0 - Added init expectation for the managed planning artifact directory.]
//   LAST_CHANGE: [v0.9.0 - Removed vv-analyst and vv-architect init expectations. Agents removed from managed-agents list.
//   LAST_CHANGE: [v0.6.2 - Updated init expectations for vv-* tracked subagent names and prompt filenames.]
//   LAST_CHANGE: [v0.6.1 - Updated init expectations so only `agent.explore` is auto-seeded among built-in OpenCode agents.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  parseVvocConfigText,
  VVOC_CONFIG_SCHEMA_URL,
  VVOC_CONFIG_VERSION,
} from "../lib/vvoc-config.js";
import { resolvePaths } from "../lib/opencode.js";

test("resolvePaths - global scope resolves correctly", async () => {
  const result = await resolvePaths({ scope: "global", cwd: "/tmp/test" });
  expect(result.scope).toBe("global");
});

test("resolvePaths - project scope resolves correctly", async () => {
  const result = await resolvePaths({
    scope: "project",
    cwd: "/tmp/test",
    configDir: "/tmp/vvoc-config-home",
  });
  expect(result.scope).toBe("project");
});

describe("init scenarios", () => {
  test("init creates role-based canonical config and managed OpenCode defaults", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const os = await import("node:os");

    const tmpDir = mkdtempSync(join(os.tmpdir(), "vvoc-test-"));
    const configHome = mkdtempSync(join(os.tmpdir(), "vvoc-config-home-"));
    try {
      const { runInit } = await import("./init.js");
      await runInit({
        scope: "project",
        cwd: tmpDir,
        configDir: configHome,
        nonInteractive: true,
      });

      const { readFileSync, existsSync } = await import("node:fs");
      const paths = await resolvePaths({ scope: "project", cwd: tmpDir, configDir: configHome });

      expect(paths.opencodeConfigPath).toBe(join(tmpDir, ".opencode", "opencode.json"));
      expect(paths.vvocConfigPath).toBe(join(tmpDir, ".vvoc", "vvoc.json"));
      expect(existsSync(paths.opencodeConfigPath)).toBe(true);
      expect(existsSync(paths.vvocConfigPath)).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/guardian.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/vv-controller.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/enhancer.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/vv-implementer.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/vv-spec-reviewer.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/vv-code-reviewer.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/investigator.md")).toBe(true);
      expect(existsSync(paths.managedSkillsDirPath + "/vv-spec/SKILL.md")).toBe(true);
      expect(existsSync(paths.managedSkillsDirPath + "/vv-plan/SKILL.md")).toBe(true);
      expect(existsSync(paths.managedSkillsDirPath + "/vv-review/SKILL.md")).toBe(true);
      expect(existsSync(paths.managedSkillsDirPath + "/vv-execute/SKILL.md")).toBe(true);
      expect(existsSync(join(configHome, "opencode"))).toBe(false);
      expect(existsSync(join(configHome, "vvoc"))).toBe(false);
      expect(existsSync(join(tmpDir, ".vvoc", "guardian.jsonc"))).toBe(false);
      expect(existsSync(join(tmpDir, ".vvoc", "secrets-redaction.config.json"))).toBe(false);

      const opencodeContent = readFileSync(paths.opencodeConfigPath, "utf8");
      const vvocContent = readFileSync(paths.vvocConfigPath, "utf8");
      const opencodeConfig = JSON.parse(opencodeContent) as {
        model: string;
        small_model: string;
        default_agent: string;
        agent: Record<string, { model?: string; prompt?: string }>;
        command: Record<string, { agent?: string }>;
        skills?: { paths?: string[] };
      };
      const vvocConfig = parseVvocConfigText(vvocContent, paths.vvocConfigPath);

      expect(opencodeContent).toContain("@osovv/vv-opencode");
      expect(opencodeConfig.model).toBe("vv-role:default");
      expect(opencodeConfig.small_model).toBe("vv-role:fast");
      expect(opencodeConfig.default_agent).toBe("vv-controller");
      expect(opencodeConfig.agent.build).toBeUndefined();
      expect(opencodeConfig.agent.plan).toBeUndefined();
      expect(opencodeConfig.agent.general).toBeUndefined();
      expect(opencodeConfig.agent.explore?.model).toBe("vv-role:fast");
      expect(opencodeConfig.agent["vv-controller"]?.model).toBe("vv-role:smart");
      expect(opencodeConfig.agent.enhancer?.model).toBe("vv-role:smart");
      expect(opencodeConfig.agent["vv-implementer"]?.model).toBe("vv-role:default");
      expect(opencodeConfig.agent["vv-spec-reviewer"]?.model).toBe("vv-role:reviewer");
      expect(opencodeConfig.agent["vv-code-reviewer"]?.model).toBe("vv-role:reviewer");
      expect(opencodeConfig.agent.investigator?.model).toBe("vv-role:smart");
      expect(opencodeConfig.agent["vv-controller"]?.prompt).toContain("{file:");
      expect(opencodeConfig.agent.enhancer?.prompt).toContain("{file:");
      expect(opencodeConfig.agent["vv-implementer"]?.prompt).toContain("{file:");
      expect(opencodeConfig.agent["vv-spec-reviewer"]?.prompt).toContain("{file:");
      expect(opencodeConfig.agent["vv-code-reviewer"]?.prompt).toContain("{file:");
      expect(opencodeConfig.agent.investigator?.prompt).toContain("{file:");
      expect(opencodeConfig.skills?.paths).toContain("../.vvoc/skills");

      expect(vvocConfig.version).toBe(VVOC_CONFIG_VERSION);
      expect(vvocConfig.$schema).toBe(VVOC_CONFIG_SCHEMA_URL);
      expect(vvocConfig.roles.default).toBeDefined();
      expect(vvocConfig.roles.smart).toBeDefined();
      expect(vvocConfig.roles.fast).toBeDefined();
      expect(vvocConfig.roles.vision).toBeDefined();
      expect(vvocConfig.roles.reviewer).toBeDefined();
      expect(vvocConfig.presets["vv-openai"]?.agents.default).toBeDefined();
      expect(vvocConfig.presets["vv-zai"]?.agents.default).toBeDefined();
      expect(vvocConfig.presets["vv-minimax"]?.agents.default).toBeDefined();
      expect(vvocConfig.presets["vv-osovv"]?.agents.default).toBeDefined();
    } finally {
      rmSync(configHome, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("init is idempotent when already configured", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const os = await import("node:os");

    const tmpDir = mkdtempSync(join(os.tmpdir(), "vvoc-test-"));
    const configHome = mkdtempSync(join(os.tmpdir(), "vvoc-config-home-"));
    try {
      const { runInit } = await import("./init.js");

      await runInit({
        scope: "project",
        cwd: tmpDir,
        configDir: configHome,
        nonInteractive: true,
      });

      const { readFileSync } = await import("node:fs");
      const paths = await resolvePaths({ scope: "project", cwd: tmpDir, configDir: configHome });
      const beforeOpenCode = readFileSync(paths.opencodeConfigPath, "utf8");
      const beforeVvoc = readFileSync(paths.vvocConfigPath, "utf8");

      await runInit({
        scope: "project",
        cwd: tmpDir,
        configDir: configHome,
        nonInteractive: true,
      });

      const afterOpenCode = readFileSync(paths.opencodeConfigPath, "utf8");
      const afterVvoc = readFileSync(paths.vvocConfigPath, "utf8");
      expect(afterOpenCode).toBe(beforeOpenCode);
      expect(afterVvoc).toBe(beforeVvoc);
    } finally {
      rmSync(configHome, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
