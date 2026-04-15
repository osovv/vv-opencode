// FILE: src/commands/init.test.ts
// VERSION: 0.6.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-INIT - interactive project initialization.
//   SCOPE: Non-interactive init path, managed agent registration, managed agent prompt scaffolding, canonical config scaffolding, and idempotent re-run handling.
//   DEPENDS: [src/commands/init.ts]
//   LINKS: [M-CLI-INIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Test suite for init command.
// END_MODULE_MAP

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

      expect(existsSync(paths.opencodeConfigPath)).toBe(true);
      expect(existsSync(paths.vvocConfigPath)).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/guardian.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/memory-reviewer.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/enhancer.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/implementer.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/spec-reviewer.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/code-reviewer.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/investitagor.md")).toBe(true);
      expect(existsSync(join(tmpDir, ".vvoc", "guardian.jsonc"))).toBe(false);
      expect(existsSync(join(tmpDir, ".vvoc", "memory.jsonc"))).toBe(false);
      expect(existsSync(join(tmpDir, ".vvoc", "secrets-redaction.config.json"))).toBe(false);

      const opencodeContent = readFileSync(paths.opencodeConfigPath, "utf8");
      const vvocContent = readFileSync(paths.vvocConfigPath, "utf8");
      const opencodeConfig = JSON.parse(opencodeContent) as {
        model: string;
        small_model: string;
        agent: Record<string, { model?: string; prompt?: string }>;
      };
      const vvocConfig = parseVvocConfigText(vvocContent, paths.vvocConfigPath);

      expect(opencodeContent).toContain("@osovv/vv-opencode");
      expect(opencodeConfig.model).toBe("vv-role:default");
      expect(opencodeConfig.small_model).toBe("vv-role:fast");
      expect(opencodeConfig.agent.build?.model).toBe("vv-role:smart");
      expect(opencodeConfig.agent.plan?.model).toBe("vv-role:smart");
      expect(opencodeConfig.agent.general?.model).toBe("vv-role:default");
      expect(opencodeConfig.agent.explore?.model).toBe("vv-role:fast");
      expect(opencodeConfig.agent.enhancer?.model).toBe("vv-role:smart");
      expect(opencodeConfig.agent.implementer?.model).toBe("vv-role:default");
      expect(opencodeConfig.agent["spec-reviewer"]?.model).toBe("vv-role:smart");
      expect(opencodeConfig.agent["code-reviewer"]?.model).toBe("vv-role:smart");
      expect(opencodeConfig.agent.investitagor?.model).toBe("vv-role:smart");
      expect(opencodeConfig.agent.enhancer?.prompt).toContain("{file:");
      expect(opencodeConfig.agent.implementer?.prompt).toContain("{file:");
      expect(opencodeConfig.agent["spec-reviewer"]?.prompt).toContain("{file:");
      expect(opencodeConfig.agent["code-reviewer"]?.prompt).toContain("{file:");
      expect(opencodeConfig.agent.investitagor?.prompt).toContain("{file:");

      expect(vvocConfig.version).toBe(VVOC_CONFIG_VERSION);
      expect(vvocConfig.$schema).toBe(VVOC_CONFIG_SCHEMA_URL);
      expect(vvocConfig.roles.default).toBeDefined();
      expect(vvocConfig.roles.smart).toBeDefined();
      expect(vvocConfig.roles.fast).toBeDefined();
      expect(vvocConfig.roles.vision).toBeDefined();
      expect(vvocConfig.presets["vv-openai"]?.agents.default).toBeDefined();
      expect(vvocConfig.presets["vv-zai"]?.agents.default).toBeDefined();
      expect(vvocConfig.presets["vv-minimax"]?.agents.default).toBeDefined();
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
