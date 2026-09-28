// FILE: src/commands/init.test.ts
// VERSION: 0.10.2
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-INIT - interactive project initialization.
//   SCOPE: Non-interactive init path, local project runtime/TUI config layers, managed agent/skill/plan scaffolding, canonical config scaffolding, global side-effect guards, and idempotent re-run handling.
//   DEPENDS: [src/commands/init.ts]
//   LINKS: [M-CLI-INIT, V-M-CLI-INIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   [test scenarios] - Init behavior coverage is expressed through module-level tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [direct fix - Seeded-config assertion follows the shipped vv-osovv-ds preset name.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  parseVvocConfigText,
  VVOC_CONFIG_SCHEMA_URL,
  VVOC_CONFIG_VERSION,
} from "../lib/vvoc-config.js";
import { resolvePaths, SUPPORTED_OPENCODE_VERSION_RANGE } from "../lib/opencode.js";

const SUPPORTED_RUNTIME = async () => ({
  version: "2.0.18",
  supportedRange: SUPPORTED_OPENCODE_VERSION_RANGE,
  versionSupported: true,
});

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
        inspectRuntime: SUPPORTED_RUNTIME,
      });

      const { readFileSync, existsSync } = await import("node:fs");
      const paths = await resolvePaths({ scope: "project", cwd: tmpDir, configDir: configHome });

      expect(paths.opencodeConfigPath).toBe(join(tmpDir, ".opencode", "opencode.json"));
      expect(paths.vvocConfigPath).toBe(join(tmpDir, ".vvoc", "vvoc.json"));
      expect(existsSync(paths.opencodeConfigPath)).toBe(true);
      expect(existsSync(paths.vvocConfigPath)).toBe(true);
      expect(existsSync(join(tmpDir, ".opencode", "tui.json"))).toBe(false);
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
      expect(existsSync(paths.managedSkillsDirPath + "/vv-reflect/SKILL.md")).toBe(true);
      expect(existsSync(paths.managedSkillsDirPath + "/vv-handoff/SKILL.md")).toBe(true);
      expect(existsSync(join(configHome, "opencode"))).toBe(false);
      expect(existsSync(join(configHome, "vvoc"))).toBe(false);
      expect(existsSync(join(tmpDir, ".vvoc", "guardian.jsonc"))).toBe(false);
      expect(existsSync(join(tmpDir, ".vvoc", "secrets-redaction.config.json"))).toBe(false);

      const opencodeContent = readFileSync(paths.opencodeConfigPath, "utf8");
      const vvocContent = readFileSync(paths.vvocConfigPath, "utf8");
      const opencodeConfig = JSON.parse(opencodeContent) as {
        model?: unknown;
        small_model?: unknown;
        default_agent?: string;
        agent?: unknown;
        agents?: unknown;
        plugins?: Array<string | { package: string }>;
        skills?: string[];
      };
      const vvocConfig = parseVvocConfigText(vvocContent, paths.vvocConfigPath);

      expect(opencodeContent).toContain("@osovv/vv-opencode");
      expect(
        opencodeConfig.plugins?.some((entry) =>
          typeof entry === "string"
            ? entry.includes("vv-opencode")
            : entry.package.includes("vv-opencode"),
        ),
      ).toBe(true);
      expect(opencodeConfig.model).toBeUndefined();
      expect(opencodeConfig.small_model).toBeUndefined();
      expect(opencodeConfig.agent).toBeUndefined();
      expect(opencodeConfig.agents).toBeUndefined();
      expect(opencodeConfig.default_agent).toBe("vv-controller");
      expect(opencodeConfig.skills).toContain(".vvoc/skills");

      const controllerMarkdown = readFileSync(
        join(paths.managedAgentsDirPath, "vv-controller.md"),
        "utf8",
      );
      expect(controllerMarkdown).toContain("mode: primary");
      expect(controllerMarkdown).toContain("Managed by vvoc");
      expect(controllerMarkdown).not.toContain("prompt:");

      expect(vvocConfig.version).toBe(VVOC_CONFIG_VERSION);
      expect(vvocConfig.$schema).toBe(VVOC_CONFIG_SCHEMA_URL);
      expect(vvocConfig.roles.default).toBeDefined();
      expect(vvocConfig.roles.smart).toBeDefined();
      expect(vvocConfig.roles.fast).toBeDefined();
      expect(vvocConfig.roles.reviewer).toBeDefined();
      expect(vvocConfig.presets["vv-codex"]?.agents.default).toBeDefined();
      expect(vvocConfig.presets["vv-zai"]?.agents.default).toBeDefined();
      expect(vvocConfig.presets["vv-deepseek"]?.agents.default).toBeDefined();
      expect(vvocConfig.presets["vv-osovv-ds"]?.agents.default).toBeDefined();
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
        inspectRuntime: SUPPORTED_RUNTIME,
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
        inspectRuntime: SUPPORTED_RUNTIME,
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
