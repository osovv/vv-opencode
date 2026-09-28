// FILE: src/commands/patch-provider.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-PATCH-PROVIDER - global native OpenCode provider patch presets.
//   SCOPE: Preset validation plus global/project native `providers` patch application with real models, native variants[], and preserved root/user fields.
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
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-007 - Re-pointed provider patch coverage at native real models with native variants[], including the MiMo thinking variant.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config as NativeConfig } from "@opencode/schema/config";
import {
  applyAllPatchProviderPresets,
  applyPatchProviderPreset,
  resolvePatchProviderPreset,
} from "./patch-provider.js";

type PresetValue = Record<string, unknown>;
type NativeModel = {
  name?: string;
  limit?: { context?: number; input?: number; output?: number };
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
  settings?: Record<string, unknown>;
  body?: Record<string, unknown>;
  variants?: Array<{
    id: string;
    settings?: Record<string, unknown>;
    body?: Record<string, unknown>;
  }>;
};
type NativeConfig = {
  model?: unknown;
  small_model?: unknown;
  plugins?: unknown[];
  providers?: Record<string, { models?: Record<string, NativeModel> }>;
};

function valueOf(preset: { value: PresetValue }): PresetValue {
  return JSON.parse(JSON.stringify(preset.value)) as PresetValue;
}

function presetModels(value: PresetValue): Record<string, NativeModel> {
  return (value.models as Record<string, NativeModel> | undefined) ?? {};
}

function variantIds(model: NativeModel): string[] {
  return (model.variants ?? []).map((variant) => variant.id);
}

describe("resolvePatchProviderPreset", () => {
  test("returns the built-in stepfun provider patch with native step-3.7-flash model", () => {
    const preset = resolvePatchProviderPreset("stepfun-ai") as unknown as { value: PresetValue };
    expect(resolvePatchProviderPreset("stepfun-ai")).toMatchObject({
      kind: "provider-object",
      providerID: "stepfun",
      summary: "providers.stepfun.models.step-3.7-flash + settings.baseURL patched",
    });
    const value = valueOf(preset);
    expect((value.settings as { baseURL?: string }).baseURL).toBe("https://api.stepfun.ai/v1");
    const model = presetModels(value)["step-3.7-flash"];
    expect(model.name).toBe("Step 3.7 Flash");
    expect(model.limit?.context).toBe(256000);
    expect(model.capabilities?.input).toEqual(["text", "image", "video"]);
  });

  test("returns the built-in codex patch over real OpenAI models", () => {
    const preset = resolvePatchProviderPreset("codex") as unknown as { value: PresetValue };
    expect(resolvePatchProviderPreset("codex")).toMatchObject({
      kind: "provider-object",
      providerID: "openai",
      summary: "providers.openai.models real gpt-5.5/5.6/6 models + effort variants patched",
    });
    const models = presetModels(valueOf(preset));
    expect(Object.keys(models).sort()).toEqual([
      "gpt-5.3-codex-spark",
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-6-astra",
      "gpt-6-luna",
    ]);
    expect(variantIds(models["gpt-5.5"])).toEqual(["xhigh"]);
    expect(variantIds(models["gpt-5.6-terra"])).toEqual(["high"]);
    expect(variantIds(models["gpt-5.6-sol"])).toEqual(["xhigh"]);
  });

  test("returns the built-in alibaba patch with qwen3.8-max#xhigh", () => {
    const preset = resolvePatchProviderPreset("alibaba") as unknown as { value: PresetValue };
    const model = presetModels(valueOf(preset))["qwen3.8-max"];
    expect(model.limit).toEqual({ context: 1000000, output: 131072 });
    expect(model.variants).toEqual([{ id: "xhigh", settings: { reasoningEffort: "xhigh" } }]);
  });

  test("returns the built-in deepseek patch with native effort variants", () => {
    const preset = resolvePatchProviderPreset("deepseek") as unknown as { value: PresetValue };
    expect(resolvePatchProviderPreset("deepseek")).toMatchObject({
      kind: "provider-object",
      providerID: "deepseek",
      summary:
        "providers.deepseek.models deepseek-flash/deepseek-v4-flash + effort variants patched",
    });
    const models = presetModels(valueOf(preset));
    expect(models["deepseek-v4-flash"].limit).toEqual({ context: 1000000, output: 384000 });
    expect(models["deepseek-v4-flash"].variants).toEqual([
      { id: "max", settings: { reasoningEffort: "max" } },
    ]);
    expect(variantIds(models["deepseek-flash"])).toEqual(["max", "high"]);
    expect(models["deepseek-flash"].variants?.[0]?.settings?.reasoningEffort).toBe("max");
    expect(models["deepseek-flash"].variants?.[1]?.settings?.reasoningEffort).toBe("high");
  });

  test("returns the built-in zai patch with GLM-5.3 effort variants", () => {
    const preset = resolvePatchProviderPreset("zai") as unknown as { value: PresetValue };
    const models = presetModels(valueOf(preset));
    expect(variantIds(models["glm-5.3"])).toEqual(["high", "max"]);
    expect(models["glm-5.3"].limit).toEqual({ context: 1000000, output: 131072 });
    expect(models["glm-5.3-flash"].capabilities?.input).toEqual(["text", "image", "video", "pdf"]);
    expect(variantIds(models["glm-5.3-flash"])).toEqual(["max"]);
  });

  test("returns the built-in xiaomi MiMo thinking variant without PDF or reasoningEffort", () => {
    const preset = resolvePatchProviderPreset("xiaomi") as unknown as { value: PresetValue };
    expect(resolvePatchProviderPreset("xiaomi")).toMatchObject({
      kind: "provider-object",
      providerID: "xiaomi",
      summary: "providers.xiaomi.models.mimo-v2.6-flash#thinking patched",
    });
    const models = presetModels(valueOf(preset));
    expect(Object.keys(models)).toEqual(["mimo-v2.6-flash"]);
    const model = models["mimo-v2.6-flash"];
    expect(model.limit).toEqual({ context: 1048576, output: 131072 });
    expect(model.capabilities?.input).toEqual(["text", "image", "audio", "video"]);
    expect(model.variants).toEqual([{ id: "thinking", body: { thinking: { type: "enabled" } } }]);
    expect(JSON.stringify(model)).not.toContain("pdf");
    expect(JSON.stringify(model)).not.toContain("reasoningEffort");
  });

  test("codex patch keeps distinct GPT-5.6 and GPT-6 limits and Spark medium", () => {
    const models = presetModels(
      valueOf(resolvePatchProviderPreset("codex") as unknown as { value: PresetValue }),
    );
    expect(models["gpt-5.6-terra"].limit).toEqual({
      context: 400000,
      input: 272000,
      output: 128000,
    });
    expect(models["gpt-6-luna"].limit).toEqual({
      context: 1050000,
      input: 922000,
      output: 128000,
    });
    expect(models["gpt-6-astra"].limit).toEqual({
      context: 1050000,
      input: 922000,
      output: 128000,
    });
    expect(models["gpt-6-luna"].variants?.[0]?.settings?.reasoningEffort).toBe("low");
    expect(models["gpt-6-astra"].variants?.[0]?.settings?.reasoningEffort).toBe("max");
    expect(models["gpt-5.3-codex-spark"].limit).toEqual({
      context: 128000,
      input: 100000,
      output: 32000,
    });
    expect(variantIds(models["gpt-5.3-codex-spark"])).toEqual(["medium"]);
    expect(models["gpt-5.3-codex-spark"].capabilities?.input).toEqual(["text"]);
  });

  test("returns the built-in openai patch through the compatibility alias", () => {
    expect(resolvePatchProviderPreset("openai")).toBe(resolvePatchProviderPreset("codex"));
  });

  test("throws for unsupported presets", () => {
    expect(() => resolvePatchProviderPreset("unknown-provider")).toThrow(
      "Unsupported OpenCode patch preset: unknown-provider. Supported presets: stepfun-ai, codex, deepseek, alibaba, zai, xiaomi. Compatibility aliases: openai",
    );
  });
});

describe("applyPatchProviderPreset", () => {
  test("writes the global native stepfun provider patch with model config", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-patch-provider-"));

    try {
      const { result } = await applyPatchProviderPreset("stepfun-ai", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const content = await readFile(join(configHome, "opencode", "opencode.json"), "utf8");
      const parsed = JSON.parse(content) as NativeConfig;

      expect(result.action).toBe("created");
      expect(parsed.providers?.stepfun?.models?.["step-3.7-flash"].name).toBe("Step 3.7 Flash");
      expect(parsed.providers?.stepfun?.models?.["step-3.7-flash"].limit?.context).toBe(256000);
      expect(parsed.providers?.stepfun?.models?.["step-3.7-flash"]).not.toHaveProperty("options");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("writes the global codex patch with real models and no vv-* aliases", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-patch-provider-"));

    try {
      const { result } = await applyPatchProviderPreset("codex", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const parsed = JSON.parse(
        await readFile(join(configHome, "opencode", "opencode.json"), "utf8"),
      ) as NativeConfig;

      expect(result.action).toBe("created");
      expect(parsed.model).toBeUndefined();
      expect(parsed.small_model).toBeUndefined();
      const models = parsed.providers?.openai?.models ?? {};
      expect(models["gpt-5.5"].limit).toEqual({
        context: 400000,
        input: 272000,
        output: 128000,
      });
      expect(models["gpt-5.5"].capabilities?.input).toEqual(["text", "image", "pdf"]);
      expect(models["gpt-5.5"].variants).toEqual([
        {
          id: "xhigh",
          settings: {
            reasoningEffort: "xhigh",
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        },
      ]);
      expect(models["gpt-5.6-terra"].variants?.[0]?.id).toBe("high");
      expect(models["gpt-5.6-sol"].variants?.[0]?.id).toBe("xhigh");
      expect(JSON.stringify(models)).not.toContain("vv-");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("reapplying the codex patch preserves siblings, root fields, plugins, and is idempotent", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-patch-provider-"));

    try {
      const configPath = join(configHome, "opencode", "opencode.json");
      await mkdir(join(configHome, "opencode"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify(
          {
            providers: {
              openai: {
                models: {
                  existing: { name: "Existing" },
                  "gpt-5.6-sol": {
                    name: "User GPT-5.6 Sol override",
                    compatibility: { requireReasoning: true },
                  },
                },
              },
            },
            model: "openai/gpt-5.6-terra#high",
            plugins: [
              {
                package: "@osovv/vv-opencode@1.7.0",
                options: { modelIntent: { smallModel: "vv-role:fast" } },
              },
            ],
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
      const parsed = JSON.parse(await readFile(configPath, "utf8")) as NativeConfig & {
        providers?: Record<string, { models?: Record<string, Record<string, unknown>> }>;
      };

      expect(first.result.action).toBe("updated");
      expect(second.result.action).toBe("kept");
      expect(parsed.model).toBe("openai/gpt-5.6-terra#high");
      expect(parsed.plugins).toEqual([
        {
          package: "@osovv/vv-opencode@1.7.0",
          options: { modelIntent: { smallModel: "vv-role:fast" } },
        },
      ]);
      const openaiModels = parsed.providers?.openai?.models ?? {};
      expect(openaiModels["existing"]).toEqual({ name: "Existing" });
      // The patch supplies a real model name but must keep the user's unrelated
      // model setting on the same key.
      expect(openaiModels["gpt-5.6-sol"]?.name).toBe("GPT-5.6 Sol");
      expect(openaiModels["gpt-5.6-sol"]?.compatibility).toEqual({ requireReasoning: true });
      expect(openaiModels["gpt-5.6-terra"]).toBeDefined();
      expect(openaiModels["gpt-6-luna"]).toBeDefined();
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("writes the global alibaba patch idempotently", async () => {
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
      const parsed = JSON.parse(
        await readFile(join(configHome, "opencode", "opencode.json"), "utf8"),
      ) as NativeConfig;

      expect(first.result.action).toBe("created");
      expect(second.result.action).toBe("kept");
      expect(parsed.providers?.["alibaba-token-plan"]?.models?.["qwen3.8-max"].variants).toEqual([
        { id: "xhigh", settings: { reasoningEffort: "xhigh" } },
      ]);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("writes the global deepseek patch idempotently and preserves root fields and siblings", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-patch-provider-"));

    try {
      const configPath = join(configHome, "opencode", "opencode.json");
      await mkdir(join(configHome, "opencode"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify(
          {
            providers: {
              deepseek: {
                models: { existing: { name: "Existing DeepSeek" } },
              },
            },
            model: "deepseek/deepseek-flash#max",
            plugins: [
              {
                package: "@osovv/vv-opencode@1.7.0",
                options: { modelIntent: { smallModel: "vv-role:fast" } },
              },
            ],
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const first = await applyPatchProviderPreset("deepseek", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const second = await applyPatchProviderPreset("deepseek", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const parsed = JSON.parse(await readFile(configPath, "utf8")) as NativeConfig;

      expect(first.result.action).toBe("updated");
      expect(second.result.action).toBe("kept");
      expect(parsed.model).toBe("deepseek/deepseek-flash#max");
      expect(parsed.plugins?.[0]).toMatchObject({
        options: { modelIntent: { smallModel: "vv-role:fast" } },
      });
      const models = parsed.providers?.deepseek?.models ?? {};
      expect(models["existing"]).toEqual({ name: "Existing DeepSeek" });
      expect(variantIds(models["deepseek-v4-flash"])).toEqual(["max"]);
      expect(variantIds(models["deepseek-flash"])).toEqual(["max", "high"]);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("writes the global zai patch idempotently and preserves root fields and siblings", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-patch-provider-"));

    try {
      const configPath = join(configHome, "opencode", "opencode.json");
      await mkdir(join(configHome, "opencode"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify(
          {
            providers: {
              "zai-coding-plan": {
                models: { existing: { name: "Existing ZAI" } },
              },
            },
            model: "zai-coding-plan/glm-5.3#max",
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const first = await applyPatchProviderPreset("zai", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const second = await applyPatchProviderPreset("zai", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const parsed = JSON.parse(await readFile(configPath, "utf8")) as NativeConfig;

      expect(first.result.action).toBe("updated");
      expect(second.result.action).toBe("kept");
      expect(parsed.model).toBe("zai-coding-plan/glm-5.3#max");
      const models = parsed.providers?.["zai-coding-plan"]?.models ?? {};
      expect(models["existing"]).toEqual({ name: "Existing ZAI" });
      expect(variantIds(models["glm-5.3"])).toEqual(["high", "max"]);
      expect(variantIds(models["glm-5.3-flash"])).toEqual(["max"]);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("applyAllPatchProviderPresets applies every registered native patch in order", async () => {
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
        "alibaba",
        "zai",
        "xiaomi",
      ]);
      expect(results.map((entry) => entry.result.action)).toEqual([
        "created",
        "updated",
        "updated",
        "updated",
        "updated",
        "updated",
      ]);

      const parsed = JSON.parse(
        await readFile(join(configHome, "opencode", "opencode.json"), "utf8"),
      ) as NativeConfig;
      expect(
        parsed.providers?.deepseek?.models?.["deepseek-flash"].variants?.[0]?.settings
          ?.reasoningEffort,
      ).toBe("max");
      expect(
        parsed.providers?.deepseek?.models?.["deepseek-flash"].variants?.[1]?.settings
          ?.reasoningEffort,
      ).toBe("high");
      expect(variantIds(parsed.providers?.["zai-coding-plan"]?.models?.["glm-5.3"] ?? {})).toEqual([
        "high",
        "max",
      ]);
      const mimo = parsed.providers?.xiaomi?.models?.["mimo-v2.6-flash"];
      expect(mimo?.variants).toEqual([{ id: "thinking", body: { thinking: { type: "enabled" } } }]);
      expect(JSON.stringify(parsed.providers)).not.toContain("vv-");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("preserves user-added variants while applying the MiMo thinking variant, natively decodable", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-patch-variant-"));
    const schemaRequire = createRequire(import.meta.resolve("@opencode/schema/config"));
    const nativeDecode = (schema: unknown) =>
      (
        schemaRequire("effect") as {
          Schema: { decodeUnknownSync: (target: unknown) => (input: unknown) => unknown };
        }
      ).Schema.decodeUnknownSync(schema);

    try {
      const configPath = join(configHome, "opencode", "opencode.json");
      await mkdir(join(configHome, "opencode"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify(
          {
            providers: {
              xiaomi: {
                models: {
                  "mimo-v2.6-flash": {
                    name: "User MiMo",
                    settings: { temperature: 0.1 },
                    variants: [{ id: "user-custom", body: { temperature: 0.7 } }],
                  },
                },
              },
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const first = await applyPatchProviderPreset("xiaomi", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const second = await applyPatchProviderPreset("xiaomi", {
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
        providers?: Record<
          string,
          {
            models?: Record<
              string,
              {
                name?: string;
                settings?: Record<string, unknown>;
                variants?: Array<{ id: string; body?: Record<string, unknown> }>;
              }
            >;
          }
        >;
      };

      expect(first.result.action).toBe("updated");
      expect(second.result.action).toBe("kept");
      const model = parsed.providers?.xiaomi?.models?.["mimo-v2.6-flash"];
      expect(model?.name).toBe("MiMo V2.6 Flash");
      expect(model?.settings?.temperature).toBe(0.1);
      expect(model?.variants?.map((variant) => variant.id)).toEqual(["user-custom", "thinking"]);
      expect(model?.variants?.[0]?.body?.temperature).toBe(0.7);
      expect(model?.variants?.[1]?.body).toEqual({ thinking: { type: "enabled" } });
      // The resulting document decodes with the pinned native schema.
      expect(() => nativeDecode(NativeConfig.Info)(parsed)).not.toThrow();
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("preserves a user variant across every shipped preset", async () => {
    for (const presetName of [
      "stepfun-ai",
      "codex",
      "deepseek",
      "alibaba",
      "zai",
      "xiaomi",
    ] as const) {
      const preset = resolvePatchProviderPreset(presetName) as unknown as {
        providerID: string;
        value: { models: Record<string, unknown> };
      };
      const modelKey = Object.keys(preset.value.models)[0];
      const configHome = await mkdtemp(join(tmpdir(), `vvoc-patch-variant-${presetName}-`));
      try {
        const configPath = join(configHome, "opencode", "opencode.json");
        await mkdir(join(configHome, "opencode"), { recursive: true });
        await writeFile(
          configPath,
          JSON.stringify(
            {
              providers: {
                [preset.providerID]: {
                  models: {
                    [modelKey]: {
                      name: "User Model",
                      variants: [{ id: "user-custom", body: { temperature: 0.7 } }],
                    },
                  },
                },
              },
            },
            null,
            2,
          ) + "\n",
          "utf8",
        );

        await applyPatchProviderPreset(presetName, {
          cwd: "/workspace/project",
          configDir: configHome,
        });
        const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
          providers?: Record<
            string,
            { models?: Record<string, { variants?: Array<{ id: string }> }> }
          >;
        };
        const variants = parsed.providers?.[preset.providerID]?.models?.[modelKey]?.variants ?? [];
        expect(variants.some((variant) => variant.id === "user-custom")).toBe(true);
      } finally {
        await rm(configHome, { recursive: true, force: true });
      }
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
