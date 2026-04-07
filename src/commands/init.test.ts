// FILE: src/commands/init.test.ts
// VERSION: 0.4.1
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-INIT - interactive project initialization.
//   SCOPE: Non-interactive init path, managed agent prompt scaffolding, config scaffolding, and idempotent re-run handling.
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
  const result = await resolvePaths({ scope: "project", cwd: "/tmp/test" });
  expect(result.scope).toBe("project");
});

describe("init scenarios", () => {
  test("init creates configs with correct structure", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const os = await import("node:os");

    const tmpDir = mkdtempSync(join(os.tmpdir(), "vvoc-test-"));
    try {
      const { runInitNonInteractive } = await import("./init.js");
      await runInitNonInteractive({
        scope: "project",
        cwd: tmpDir,
      });

      const { readFileSync, existsSync } = await import("node:fs");
      const paths = await resolvePaths({ scope: "project", cwd: tmpDir });

      expect(existsSync(paths.opencodeConfigPath)).toBe(true);
      expect(existsSync(paths.guardianConfigPath)).toBe(true);
      expect(existsSync(paths.memoryConfigPath)).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/guardian.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/memory-reviewer.md")).toBe(true);
      expect(existsSync(paths.managedAgentsDirPath + "/implementer.md")).toBe(true);

      const opencodeContent = readFileSync(paths.opencodeConfigPath, "utf8");
      expect(opencodeContent).toContain("@osovv/vv-opencode");
      expect(opencodeContent).toContain('"implementer"');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("init is idempotent when already configured", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const os = await import("node:os");

    const tmpDir = mkdtempSync(join(os.tmpdir(), "vvoc-test-"));
    try {
      const { runInitNonInteractive } = await import("./init.js");

      await runInitNonInteractive({
        scope: "project",
        cwd: tmpDir,
      });

      await runInitNonInteractive({
        scope: "project",
        cwd: tmpDir,
      });

      const { readFileSync } = await import("node:fs");
      const paths = await resolvePaths({ scope: "project", cwd: tmpDir });
      const opencodeContent = readFileSync(paths.opencodeConfigPath, "utf8");
      expect(opencodeContent).toContain("@osovv/vv-opencode");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
