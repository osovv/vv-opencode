// FILE: src/commands/patch-provider.test.ts
// VERSION: 0.8.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-PATCH-PROVIDER - global OpenCode patch presets.
//   SCOPE: Preset validation plus global OpenCode provider and provider-specific patch application without root model rewrites.
//   DEPENDS: [bun:test, src/commands/patch-provider.ts]
//   LINKS: [M-CLI-PATCH-PROVIDER, V-M-CLI-PATCH-PROVIDER]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   [test scenarios] - Patch-provider behavior coverage is expressed through module-level tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.2.6 - Added the deepseek alias patch tests and official modalities across all patched models.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAllPatchProviderPresets,
  applyPatchProviderPreset,
  resolvePatchProviderPreset,
} from "./patch-provider.js";

describe("resolvePatchProviderPreset", () => {
  test("returns the built-in stepfun provider patch with step-3.7-flash model", () => {
    const preset = resolvePatchProviderPreset("stepfun-ai");
    expect(preset).toMatchObject({
      kind: "provider-object",
      providerID: "stepfun",
      summary: "provider.stepfun.models.step-3.7-flash patched + baseURL",
    });
    const value = JSON.parse(JSON.stringify((preset as { value: Record<string, unknown> }).value));
    expect(value.options.baseURL).toBe("https://api.stepfun.ai/v1");
    expect(value.models["step-3.7-flash"].name).toBe("Step 3.7 Flash");
    expect(value.models["step-3.7-flash"].limit.context).toBe(256000);
    expect(value.models["step-3.7-flash"].modalities.input).toEqual(["text", "image", "video"]);
  });

  test("returns the built-in codex alias patch (canonical)", () => {
    expect(resolvePatchProviderPreset("codex")).toMatchObject({
      kind: "provider-object",
      providerID: "openai",
      summary: "provider.openai.models vv-codex-gpt-5.5/5.6 aliases patched",
    });
  });
  test("returns the built-in kimi alias patch", () => {
    expect(resolvePatchProviderPreset("kimi")).toMatchObject({
      kind: "provider-object",
      providerID: "moonshotai",
      summary: "provider.moonshotai.models.vv-kimi-k3-max patched",
    });
    const value = JSON.parse(
      JSON.stringify(
        (resolvePatchProviderPreset("kimi") as { value: Record<string, unknown> }).value,
      ),
    );
    expect(value.models["vv-kimi-k3-max"].id).toBe("kimi-k3");
    expect(value.models["vv-kimi-k3-max"].options.reasoningEffort).toBe("max");
  });

  test("returns the built-in alibaba alias patch", () => {
    expect(resolvePatchProviderPreset("alibaba")).toMatchObject({
      kind: "provider-object",
      providerID: "alibaba-token-plan",
      summary: "provider.alibaba-token-plan.models.vv-qwen3.8-max-xhigh patched",
    });
    const value = JSON.parse(
      JSON.stringify(
        (resolvePatchProviderPreset("alibaba") as { value: Record<string, unknown> }).value,
      ),
    );
    expect(value.models["vv-qwen3.8-max-xhigh"].id).toBe("qwen3.8-max");
    expect(value.models["vv-qwen3.8-max-xhigh"].options.reasoningEffort).toBe("xhigh");
  });

  test("returns the built-in deepseek alias patch", () => {
    expect(resolvePatchProviderPreset("deepseek")).toMatchObject({
      kind: "provider-object",
      providerID: "deepseek",
      summary: "provider.deepseek.models.vv-deepseek-v4-flash-max patched",
    });
    const value = JSON.parse(
      JSON.stringify(
        (resolvePatchProviderPreset("deepseek") as { value: Record<string, unknown> }).value,
      ),
    );
    expect(value.models["vv-deepseek-v4-flash-max"].id).toBe("deepseek-v4-flash");
    expect(value.models["vv-deepseek-v4-flash-max"].options.reasoningEffort).toBe("max");
    expect(value.models["vv-deepseek-v4-flash-max"].modalities).toEqual({
      input: ["text"],
      output: ["text"],
    });
  });
  test("codex patch includes the vv-codex-gpt-5.6-luna-low alias", () => {
    const value = JSON.parse(
      JSON.stringify(
        (resolvePatchProviderPreset("codex") as { value: Record<string, unknown> }).value,
      ),
    );
    expect(value.models["vv-codex-gpt-5.6-luna-low"]).toMatchObject({
      id: "gpt-5.6-luna",
      limit: { input: 272000, context: 400000, output: 128000 },
    });
    expect(value.models["vv-codex-gpt-5.6-luna-low"].options.reasoningEffort).toBe("low");
  });

  test("returns the built-in openai alias patch (compatibility)", () => {
    const compatibilityPreset = resolvePatchProviderPreset("openai");
    expect(compatibilityPreset).toBe(resolvePatchProviderPreset("codex"));
    expect(compatibilityPreset).toMatchObject({
      kind: "provider-object",
      providerID: "openai",
      summary: "provider.openai.models vv-codex-gpt-5.5/5.6 aliases patched",
    });
  });

  test("throws for unsupported presets", () => {
    expect(() => resolvePatchProviderPreset("unknown-provider")).toThrow(
      "Unsupported OpenCode patch preset: unknown-provider. Supported presets: stepfun-ai, codex, deepseek, kimi, alibaba. Compatibility aliases: openai",
    );
  });
});

describe("applyPatchProviderPreset", () => {
  test("writes the global OpenCode stepfun provider patch with model config", async () => {
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
      expect(content).toContain("step-3.7-flash");
      expect(content).toContain("Step 3.7 Flash");
      expect(content).toContain("256000");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("writes the global codex alias patch without mutating root model fields", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-patch-provider-"));

    try {
      const { result } = await applyPatchProviderPreset("codex", {
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
                id?: string;
                name?: string;
                reasoning?: boolean;
                variants?: Record<string, unknown>;
                limit?: {
                  context?: number;
                  input?: number;
                  output?: number;
                };
                modalities?: {
                  input?: string[];
                  output?: string[];
                };
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
      expect(parsed.model).toBeUndefined();
      expect(parsed.small_model).toBeUndefined();
      expect(parsed.provider?.openai?.models?.["vv-codex-gpt-5.5-xhigh"]).toEqual({
        name: "VV Codex GPT-5.5-XHigh",
        id: "gpt-5.5",
        variants: {},
        limit: {
          context: 400000,
          input: 272000,
          output: 128000,
        },
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        reasoning: true,
        options: {
          reasoningEffort: "xhigh",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      });
      expect(parsed.provider?.openai?.models?.["vv-codex-gpt-5.6-terra-high"]).toEqual({
        name: "VV Codex GPT-5.6 Terra High",
        id: "gpt-5.6-terra",
        variants: {},
        limit: {
          context: 400000,
          input: 272000,
          output: 128000,
        },
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        reasoning: true,
        options: {
          reasoningEffort: "high",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      });
      expect(parsed.provider?.openai?.models?.["vv-codex-gpt-5.6-sol-xhigh"]).toEqual({
        name: "VV Codex GPT-5.6 Sol XHigh",
        id: "gpt-5.6-sol",
        variants: {},
        limit: {
          context: 400000,
          input: 272000,
          output: 128000,
        },
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        reasoning: true,
        options: {
          reasoningEffort: "xhigh",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      });

      // Old vv-gpt-* aliases should not be written
      expect(parsed.provider?.openai?.models?.["vv-gpt-5.4-xhigh"]).toBeUndefined();
      expect(parsed.provider?.openai?.models?.["vv-gpt-5.5-xhigh"]).toBeUndefined();
      expect(parsed.provider?.openai?.models?.["vv-gpt-5.6-luna-low"]).toBeUndefined();
      expect(parsed.provider?.openai?.models?.["vv-gpt-5.6-terra-high"]).toBeUndefined();
      expect(parsed.provider?.openai?.models?.["vv-gpt-5.6-sol-xhigh"]).toBeUndefined();
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("reapplying the codex patch keeps sibling models, preserves root role refs, and becomes idempotent", async () => {
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
                  "vv-gpt-5.6-sol-xhigh": {
                    name: "Legacy managed alias retained conservatively",
                  },
                },
              },
            },
            model: "vv-role:default",
            small_model: "vv-role:fast",
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const first = await applyPatchProviderPreset("codex", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const second = await applyPatchProviderPreset("codex", {
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
      expect(parsed.model).toBe("vv-role:default");
      expect(parsed.small_model).toBe("vv-role:fast");
      expect(parsed.provider?.openai?.models?.existing).toEqual({ name: "Existing" });
      expect(parsed.provider?.openai?.models?.["vv-gpt-5.6-sol-xhigh"]).toEqual({
        name: "Legacy managed alias retained conservatively",
      });
      expect(parsed.provider?.openai?.models?.["vv-codex-gpt-5.5-xhigh"]?.name).toBe(
        "VV Codex GPT-5.5-XHigh",
      );
      expect(parsed.provider?.openai?.models?.["vv-codex-gpt-5.6-terra-high"]?.name).toBe(
        "VV Codex GPT-5.6 Terra High",
      );
      expect(parsed.provider?.openai?.models?.["vv-codex-gpt-5.6-sol-xhigh"]?.name).toBe(
        "VV Codex GPT-5.6 Sol XHigh",
      );
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
  test("writes the global kimi alias patch idempotently", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-patch-provider-"));

    try {
      const first = await applyPatchProviderPreset("kimi", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const second = await applyPatchProviderPreset("kimi", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const content = await readFile(join(configHome, "opencode", "opencode.json"), "utf8");
      expect(first.result.action).toBe("created");
      expect(second.result.action).toBe("kept");
      expect(content).toContain("vv-kimi-k3-max");
      expect(content).toContain("kimi-k3");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("writes the global alibaba alias patch idempotently", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-patch-provider-"));

    try {
      const first = await applyPatchProviderPreset("alibaba", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const second = await applyPatchProviderPreset("alibaba", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const content = await readFile(join(configHome, "opencode", "opencode.json"), "utf8");
      expect(first.result.action).toBe("created");
      expect(second.result.action).toBe("kept");
      expect(content).toContain("vv-qwen3.8-max-xhigh");
      expect(content).toContain("qwen3.8-max");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("writes the global deepseek alias patch idempotently", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-patch-provider-"));

    try {
      const first = await applyPatchProviderPreset("deepseek", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const second = await applyPatchProviderPreset("deepseek", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const content = await readFile(join(configHome, "opencode", "opencode.json"), "utf8");
      expect(first.result.action).toBe("created");
      expect(second.result.action).toBe("kept");
      expect(content).toContain("vv-deepseek-v4-flash-max");
      expect(content).toContain("deepseek-v4-flash");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("applyAllPatchProviderPresets applies every registered patch in order", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-patch-provider-"));

    try {
      const results = await applyAllPatchProviderPresets({
        cwd: "/workspace/project",
        configDir: configHome,
      });
      expect(results.map((entry) => entry.preset)).toEqual([
        "stepfun-ai",
        "codex",
        "deepseek",
        "kimi",
        "alibaba",
      ]);
      expect(results.map((entry) => entry.result.action)).toEqual([
        "created",
        "updated",
        "updated",
        "updated",
        "updated",
      ]);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("writes project-scope patch to .opencode without creating global OpenCode config", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-patch-provider-global-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-patch-provider-project-"));

    try {
      const { result } = await applyPatchProviderPreset("codex", {
        cwd: projectDir,
        configDir: configHome,
        scope: "project",
      });
      const content = await readFile(join(projectDir, ".opencode", "opencode.json"), "utf8");

      expect(result.path).toBe(join(projectDir, ".opencode", "opencode.json"));
      expect(content).toContain('"openai"');
      await expect(
        readFile(join(configHome, "opencode", "opencode.json"), "utf8"),
      ).rejects.toBeDefined();
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
