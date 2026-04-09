// FILE: src/commands/init.test.ts
// VERSION: 0.5.0
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
  test("init creates configs with correct structure", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const os = await import("node:os");

    const tmpDir = mkdtempSync(join(os.tmpdir(), "vvoc-test-"));
    const configHome = mkdtempSync(join(os.tmpdir(), "vvoc-config-home-"));
    try {
      const { runInitNonInteractive } = await import("./init.js");
      await runInitNonInteractive({
        scope: "project",
        cwd: tmpDir,
        configDir: configHome,
      });

      const { readFileSync, existsSync } = await import("node:fs");
      const paths = await resolvePaths({ scope: "project", cwd: tmpDir, configDir: configHome });

      expect(existsSync(paths.opencodeConfigPath)).toBe(true);
      expect(existsSync(paths.vvocConfigPath)).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/guardian.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/memory-reviewer.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/enhancer.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/implementer.md")).toBe(true);
      expect(existsSync(join(tmpDir, ".vvoc", "guardian.jsonc"))).toBe(false);
      expect(existsSync(join(tmpDir, ".vvoc", "memory.jsonc"))).toBe(false);
      expect(existsSync(join(tmpDir, ".vvoc", "secrets-redaction.config.json"))).toBe(false);

      const opencodeContent = readFileSync(paths.opencodeConfigPath, "utf8");
      const vvocContent = readFileSync(paths.vvocConfigPath, "utf8");
      expect(opencodeContent).toContain("@osovv/vv-opencode");
      expect(opencodeContent).toContain('"enhancer"');
      expect(opencodeContent).toContain('"implementer"');
      expect(vvocContent).toContain('"guardian"');
      expect(vvocContent).toContain('"memory"');
      expect(vvocContent).toContain('"secretsRedaction"');
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
      const { runInitNonInteractive } = await import("./init.js");

      await runInitNonInteractive({
        scope: "project",
        cwd: tmpDir,
        configDir: configHome,
      });

      await runInitNonInteractive({
        scope: "project",
        cwd: tmpDir,
        configDir: configHome,
      });

      const { readFileSync } = await import("node:fs");
      const paths = await resolvePaths({ scope: "project", cwd: tmpDir, configDir: configHome });
      const opencodeContent = readFileSync(paths.opencodeConfigPath, "utf8");
      expect(opencodeContent).toContain("@osovv/vv-opencode");
    } finally {
      rmSync(configHome, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
