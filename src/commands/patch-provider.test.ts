// FILE: src/commands/patch-provider.test.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-PATCH-PROVIDER - global OpenCode patch presets.
//   SCOPE: Preset validation plus global OpenCode provider, provider-specific patch application, and OpenAI alias-default patch application.
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
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.3.0 - Added coverage for the openai patch preset that installs the vv-gpt-5.4-xhigh alias model and makes it the global default.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  test("returns the built-in openai alias patch", () => {
    expect(resolvePatchProviderPreset("openai")).toMatchObject({
      kind: "provider-object-and-default-model",
      providerID: "openai",
      model: "openai/vv-gpt-5.4-xhigh",
      summary:
        "provider.openai.models.vv-gpt-5.4-xhigh patched and model set to openai/vv-gpt-5.4-xhigh",
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

  test("writes the global openai alias patch and sets it as the default model", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-patch-provider-"));

    try {
      const { result } = await applyPatchProviderPreset("openai", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const content = await readFile(join(configHome, "opencode", "opencode.json"), "utf8");
      const parsed = JSON.parse(content) as {
        model?: string;
        small_model?: string;
        provider?: Record<
          string,
          {
            models?: Record<
              string,
              {
                name?: string;
                id?: string;
                variants?: Record<string, unknown>;
                options?: {
                  reasoningEffort?: string;
                  reasoningSummary?: string;
                  include?: string[];
                };
              }
            >;
          }
        >;
      };

      expect(result.action).toBe("created");
      expect(parsed.model).toBe("openai/vv-gpt-5.4-xhigh");
      expect(parsed.small_model).toBeUndefined();
      expect(parsed.provider?.openai?.models?.["vv-gpt-5.4-xhigh"]).toEqual({
        name: "VV GPT-5.4-XHigh",
        id: "gpt-5.4",
        variants: {},
        options: {
          reasoningEffort: "xhigh",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      });
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("reapplying the openai patch keeps sibling models and becomes idempotent", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-patch-provider-"));

    try {
      const configPath = join(configHome, "opencode", "opencode.json");
      await mkdir(join(configHome, "opencode"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify(
          {
            provider: {
              openai: {
                models: {
                  existing: {
                    name: "Existing",
                  },
                },
              },
            },
            model: "openai/gpt-5.4",
            small_model: "openai/gpt-5.4-mini",
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const first = await applyPatchProviderPreset("openai", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const second = await applyPatchProviderPreset("openai", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const content = await readFile(configPath, "utf8");
      const parsed = JSON.parse(content) as {
        model?: string;
        small_model?: string;
        provider?: Record<string, { models?: Record<string, { name?: string }> }>;
      };

      expect(first.result.action).toBe("updated");
      expect(second.result.action).toBe("kept");
      expect(parsed.model).toBe("openai/vv-gpt-5.4-xhigh");
      expect(parsed.small_model).toBe("openai/gpt-5.4-mini");
      expect(parsed.provider?.openai?.models?.existing).toEqual({ name: "Existing" });
      expect(parsed.provider?.openai?.models?.["vv-gpt-5.4-xhigh"]?.name).toBe("VV GPT-5.4-XHigh");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});
