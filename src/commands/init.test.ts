// FILE: src/commands/init.test.ts
// VERSION: 0.6.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-INIT - interactive global initialization.
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
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.6.0 - Updated init coverage for the canonical global OpenCode and managed-agent layout.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { resolvePaths } from "../lib/opencode.js";

test("resolvePaths resolves the canonical global layout", async () => {
  const result = await resolvePaths({ configDir: "/tmp/vvoc-config-home" });
  expect(result.opencodeBaseDir).toBe("/tmp/vvoc-config-home/opencode");
  expect(result.vvocConfigPath).toBe("/tmp/vvoc-config-home/vvoc/vvoc.json");
  expect(result.managedAgentsDirPath).toBe("/tmp/vvoc-config-home/vvoc/agents");
});

describe("init scenarios", () => {
  test("init creates configs with correct structure", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const os = await import("node:os");

    const configHome = mkdtempSync(join(os.tmpdir(), "vvoc-config-home-"));
    try {
      const { runInitNonInteractive } = await import("./init.js");
      await runInitNonInteractive({ configDir: configHome });

      const { readFileSync, existsSync } = await import("node:fs");
      const paths = await resolvePaths({ configDir: configHome });

      expect(existsSync(paths.opencodeConfigPath)).toBe(true);
      expect(existsSync(paths.vvocConfigPath)).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/guardian.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/memory-reviewer.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/enhancer.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/implementer.md")).toBe(true);

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
    }
  });

  test("init is idempotent when already configured", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const os = await import("node:os");

    const configHome = mkdtempSync(join(os.tmpdir(), "vvoc-config-home-"));
    try {
      const { runInitNonInteractive } = await import("./init.js");

      await runInitNonInteractive({ configDir: configHome });

      await runInitNonInteractive({ configDir: configHome });

      const { readFileSync } = await import("node:fs");
      const paths = await resolvePaths({ configDir: configHome });
      const opencodeContent = readFileSync(paths.opencodeConfigPath, "utf8");
      expect(opencodeContent).toContain("@osovv/vv-opencode");
    } finally {
      rmSync(configHome, { recursive: true, force: true });
    }
  });
});
