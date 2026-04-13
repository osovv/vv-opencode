// FILE: src/commands/patch-provider.test.ts
// VERSION: 0.2.1
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-PATCH-PROVIDER - global OpenCode patch presets.
//   SCOPE: Preset validation plus global OpenCode provider and provider-specific patch application.
//   INPUTS: Built-in patch preset names and temp config homes.
//   OUTPUTS: Assertions over rewritten global OpenCode config content.
//   DEPENDS: [bun:test, src/commands/patch-provider.ts]
//   LINKS: [V-M-CLI-PATCH-PROVIDER]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Test suite for patch-provider preset resolution and application.
// END_MODULE_MAP

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatchProviderPreset, resolvePatchProviderPreset } from "./patch-provider.js";

describe("resolvePatchProviderPreset", () => {
  test("returns the built-in stepfun provider patch", () => {
    expect(resolvePatchProviderPreset("stepfun-ai")).toEqual({
      kind: "provider-base-url",
      providerID: "stepfun",
      baseURL: "https://api.stepfun.ai/v1",
      summary: "provider.stepfun.options.baseURL=https://api.stepfun.ai/v1",
    });
  });

  test("returns the built-in zai config patch", () => {
    expect(resolvePatchProviderPreset("zai")).toMatchObject({
      kind: "provider-object",
      providerID: "zai-coding-plan",
      summary: "provider.zai-coding-plan.models.glm-4.5-airx patched",
    });
  });

  test("throws for unsupported presets", () => {
    expect(() => resolvePatchProviderPreset("unknown-provider")).toThrow(
      "Unsupported OpenCode patch preset",
    );
  });
});

describe("applyPatchProviderPreset", () => {
  test("writes the global OpenCode provider baseURL override", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-patch-provider-"));

    try {
      const { result } = await applyPatchProviderPreset("stepfun-ai", {
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

  test("writes the global zai coding plan patch", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-patch-provider-"));

    try {
      const { result } = await applyPatchProviderPreset("zai", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const content = await readFile(join(configHome, "opencode", "opencode.json"), "utf8");
      const parsed = JSON.parse(content) as {
        provider?: Record<
          string,
          {
            models?: Record<
              string,
              Record<string, { limit?: { context?: number; output?: number } }>
            >;
          }
        >;
      };

      expect(result.action).toBe("created");
      expect(
        parsed.provider?.["zai-coding-plan"]?.models?.["glm-4.5-airx"]?.["name: glm-4.5-airx"]
          ?.limit,
      ).toEqual({
        context: 128000,
        output: 96000,
      });
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});
