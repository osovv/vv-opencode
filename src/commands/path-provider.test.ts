// FILE: src/commands/path-provider.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-PATH-PROVIDER - global provider patch presets.
//   SCOPE: Preset validation and global OpenCode baseURL patch application.
//   DEPENDS: [bun:test, src/commands/path-provider.ts]
//   LINKS: [V-M-CLI-PATH-PROVIDER]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Test suite for path-provider preset resolution and application.
// END_MODULE_MAP

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPathProviderPreset, resolvePathProviderPreset } from "./path-provider.js";

describe("resolvePathProviderPreset", () => {
  test("returns the built-in stepfun provider patch", () => {
    expect(resolvePathProviderPreset("stepfun-ai")).toEqual({
      providerID: "stepfun",
      baseURL: "https://api.stepfun.ai/v1",
    });
  });

  test("throws for unsupported presets", () => {
    expect(() => resolvePathProviderPreset("unknown-provider")).toThrow(
      "Unsupported provider patch preset",
    );
  });
});

describe("applyPathProviderPreset", () => {
  test("writes the global OpenCode provider baseURL override", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-path-provider-"));

    try {
      const { result } = await applyPathProviderPreset("stepfun-ai", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const content = await readFile(join(configHome, "opencode", "opencode.json"), "utf8");

      expect(result.action).toBe("created");
      expect(content).toContain('"stepfun"');
      expect(content).toContain("https://api.stepfun.ai/v1");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});
