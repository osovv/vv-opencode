// FILE: src/commands/patch-provider.ts
// VERSION: 0.10.0
// START_MODULE_CONTRACT
//   PURPOSE: Apply OpenCode patch presets to global or project OpenCode config layers.
//   SCOPE: Patch preset validation, scoped OpenCode config path resolution, provider/baseURL patch writes, provider-specific object patch writes under native `providers` with real models and native `variants[]` (stepfun-ai, codex, deepseek, alibaba, zai, xiaomi), and CLI output.
//   DEPENDS: [citty, src/lib/opencode.ts]
//   LINKS: M-CLI-PATCH-PROVIDER, M-CLI-COMPLETION, M-CLI-CONFIG
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - PatchProvider command definition for vvoc.
//   resolvePatchProviderPreset - Validate an OpenCode patch preset name and return its config.
//   PatchProviderPresetName - Supported built-in patch-provider preset names.
//   applyPatchProviderPreset - Apply the selected OpenCode patch preset to global or project OpenCode config.
//   PATCH_ALL_PRESET - Preset name constant selecting every built-in patch-provider preset.
//   applyAllPatchProviderPresets - Apply all built-in patch-provider presets in sequence to the selected scope.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-007 - Migrated every shipped alias to real native provider models with native variants[], body/settings/capabilities/limit shapes, and the MiMo thinking variant.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  describeWriteResult,
  resolvePaths,
  writeOpenCodeProviderObject,
  writeProviderBaseUrl,
} from "../lib/opencode.js";
import type { Scope } from "../lib/opencode.js";

type ProviderBaseUrlPatchPreset = {
  kind: "provider-base-url";
  providerID: string;
  baseURL: string;
  summary: string;
};

type ProviderObjectPatchPreset = {
  kind: "provider-object";
  providerID: string;
  value: Record<string, unknown>;
  summary: string;
};

type PatchPreset = ProviderBaseUrlPatchPreset | ProviderObjectPatchPreset;

/** Codex/model reasoning overlay settings shared by generated effort variants. */
function codexVariantSettings(effort: string): Record<string, unknown> {
  return {
    reasoningEffort: effort,
    reasoningSummary: "auto",
    include: ["reasoning.encrypted_content"],
  };
}

const STEPFUN_PATCH = {
  settings: {
    baseURL: "https://api.stepfun.ai/v1",
  },
  models: {
    "step-3.7-flash": {
      name: "Step 3.7 Flash",
      limit: {
        context: 256000,
        input: 256000,
        output: 256000,
      },
      capabilities: {
        tools: true,
        input: ["text", "image", "video"],
        output: ["text"],
      },
    },
  },
} satisfies Record<string, unknown>;

const OPENAI_PATCH = {
  models: {
    "gpt-5.5": {
      name: "GPT-5.5",
      limit: { context: 400000, input: 272000, output: 128000 },
      capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
      variants: [{ id: "xhigh", settings: codexVariantSettings("xhigh") }],
    },
    "gpt-5.6-terra": {
      name: "GPT-5.6 Terra",
      limit: { context: 400000, input: 272000, output: 128000 },
      capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
      variants: [{ id: "high", settings: codexVariantSettings("high") }],
    },
    "gpt-5.6-sol": {
      name: "GPT-5.6 Sol",
      limit: { context: 400000, input: 272000, output: 128000 },
      capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
      variants: [{ id: "xhigh", settings: codexVariantSettings("xhigh") }],
    },
    // GPT-6 Luna/Astra keep the official GPT-6 contract (1.05M/922K/128K);
    // only the GPT-5.6 family was capped to 272K input by Codex PR#33972.
    "gpt-6-luna": {
      name: "GPT-6 Luna",
      limit: { context: 1050000, input: 922000, output: 128000 },
      capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
      variants: [{ id: "low", settings: codexVariantSettings("low") }],
    },
    "gpt-6-astra": {
      name: "GPT-6 Astra",
      limit: { context: 1050000, input: 922000, output: 128000 },
      capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
      variants: [{ id: "max", settings: codexVariantSettings("max") }],
    },
    "gpt-5.3-codex-spark": {
      name: "GPT-5.3 Codex Spark",
      limit: { context: 128000, input: 100000, output: 32000 },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [{ id: "medium", settings: codexVariantSettings("medium") }],
    },
  },
} satisfies Record<string, unknown>;

const ALIBABA_PATCH = {
  models: {
    "qwen3.8-max": {
      name: "Qwen3.8-Max",
      limit: { context: 1000000, output: 131072 },
      capabilities: {
        tools: true,
        input: ["text", "image", "video", "pdf"],
        output: ["text"],
      },
      variants: [{ id: "xhigh", settings: { reasoningEffort: "xhigh" } }],
    },
  },
} satisfies Record<string, unknown>;

const DEEPSEEK_PATCH = {
  models: {
    "deepseek-v4-flash": {
      name: "DeepSeek V4 Flash",
      limit: { context: 1000000, output: 384000 },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [{ id: "max", settings: { reasoningEffort: "max" } }],
    },
    "deepseek-flash": {
      name: "DeepSeek Flash",
      limit: { context: 1000000, output: 384000 },
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      variants: [
        { id: "max", settings: { reasoningEffort: "max" } },
        { id: "high", settings: { reasoningEffort: "high" } },
      ],
    },
  },
} satisfies Record<string, unknown>;

const ZAI_PATCH = {
  models: {
    "glm-5.3": {
      name: "GLM-5.3",
      limit: { context: 1000000, output: 131072 },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [
        { id: "high", settings: { reasoningEffort: "high" } },
        { id: "max", settings: { reasoningEffort: "max" } },
      ],
    },
    "glm-5.3-flash": {
      name: "GLM-5.3 Flash",
      limit: { context: 1000000, output: 131072 },
      capabilities: { tools: true, input: ["text", "image", "video", "pdf"], output: ["text"] },
      variants: [{ id: "max", settings: { reasoningEffort: "max" } }],
    },
  },
} satisfies Record<string, unknown>;

const XIAOMI_PATCH = {
  models: {
    // Real Xiaomi API model id; thinking is a native variant that enables the
    // documented thinking toggle. No PDF declaration, no reasoningEffort, no alias.
    "mimo-v2.6-flash": {
      name: "MiMo V2.6 Flash",
      limit: { context: 1048576, output: 131072 },
      capabilities: {
        tools: true,
        input: ["text", "image", "audio", "video"],
        output: ["text"],
      },
      variants: [{ id: "thinking", body: { thinking: { type: "enabled" } } }],
    },
  },
} satisfies Record<string, unknown>;

const PATCH_PROVIDER_PRESETS = {
  "stepfun-ai": {
    kind: "provider-object",
    providerID: "stepfun",
    value: STEPFUN_PATCH,
    summary: "providers.stepfun.models.step-3.7-flash + settings.baseURL patched",
  },
  codex: {
    kind: "provider-object",
    providerID: "openai",
    value: OPENAI_PATCH,
    summary: "providers.openai.models real gpt-5.5/5.6/6 models + effort variants patched",
  },
  deepseek: {
    kind: "provider-object",
    providerID: "deepseek",
    value: DEEPSEEK_PATCH,
    summary: "providers.deepseek.models deepseek-flash/deepseek-v4-flash + effort variants patched",
  },
  alibaba: {
    kind: "provider-object",
    providerID: "alibaba-token-plan",
    value: ALIBABA_PATCH,
    summary: "providers.alibaba-token-plan.models.qwen3.8-max#xhigh patched",
  },
  zai: {
    kind: "provider-object",
    providerID: "zai-coding-plan",
    value: ZAI_PATCH,
    summary: "providers.zai-coding-plan.models glm-5.3/glm-5.3-flash + effort variants patched",
  },
  xiaomi: {
    kind: "provider-object",
    providerID: "xiaomi",
    value: XIAOMI_PATCH,
    summary: "providers.xiaomi.models.mimo-v2.6-flash#thinking patched",
  },
} as const satisfies Record<string, PatchPreset>;

/** Special preset name that applies every registered patch preset in sequence. */
export const PATCH_ALL_PRESET = "all";

/** Applies every registered patch preset sequentially; returns per-preset results. */
export async function applyAllPatchProviderPresets(options: {
  cwd?: string;
  configDir?: string;
  scope?: Scope;
}): Promise<
  {
    preset: PatchProviderPresetName;
    result: Awaited<ReturnType<typeof applyPatchProviderPreset>>["result"];
  }[]
> {
  const results: {
    preset: PatchProviderPresetName;
    result: Awaited<ReturnType<typeof applyPatchProviderPreset>>["result"];
  }[] = [];
  for (const presetName of Object.keys(PATCH_PROVIDER_PRESETS) as PatchProviderPresetName[]) {
    const { result } = await applyPatchProviderPreset(presetName, options);
    results.push({ preset: presetName, result });
  }
  return results;
}

export type PatchProviderPresetName = keyof typeof PATCH_PROVIDER_PRESETS;

const PATCH_PROVIDER_PRESET_ALIASES = {
  openai: "codex",
} as const satisfies Record<string, PatchProviderPresetName>;

const presetArg = {
  type: "positional" as const,
  required: true,
  description: "OpenCode patch preset to apply.",
};

const configDirArg = {
  type: "string" as const,
  description: "Override the global config home used for opencode/.",
};

const writeScopeArg = {
  type: "enum" as const,
  options: ["global", "project"],
  default: "global",
  description: "Write global config or project-local config.",
};

// START_BLOCK_PROVIDER_PRESET_RESOLUTION
export function resolvePatchProviderPreset(name: string): PatchPreset {
  const requestedName = name.trim();
  const presetName =
    requestedName in PATCH_PROVIDER_PRESET_ALIASES
      ? PATCH_PROVIDER_PRESET_ALIASES[requestedName as keyof typeof PATCH_PROVIDER_PRESET_ALIASES]
      : (requestedName as PatchProviderPresetName);
  if (presetName in PATCH_PROVIDER_PRESETS) {
    return PATCH_PROVIDER_PRESETS[presetName];
  }

  const supported = Object.keys(PATCH_PROVIDER_PRESETS).join(", ");
  const aliases = Object.keys(PATCH_PROVIDER_PRESET_ALIASES).join(", ");
  throw new Error(
    `Unsupported OpenCode patch preset: ${name}. Supported presets: ${supported}. Compatibility aliases: ${aliases}`,
  );
}

export async function applyPatchProviderPreset(
  presetName: string,
  options: { cwd?: string; configDir?: string; scope?: Scope } = {},
) {
  const preset = resolvePatchProviderPreset(presetName);
  const paths = await resolvePaths({
    scope: options.scope ?? "global",
    cwd: options.cwd ?? process.cwd(),
    configDir: options.configDir,
  });

  const result =
    preset.kind === "provider-base-url"
      ? await writeProviderBaseUrl(paths, preset.providerID, preset.baseURL)
      : await writeOpenCodeProviderObject(paths, preset.providerID, preset.value);

  return { preset, result };
}
// END_BLOCK_PROVIDER_PRESET_RESOLUTION

export default defineCommand({
  meta: {
    name: "patch-provider",
    description: "Apply a global OpenCode patch preset.",
  },
  args: {
    preset: presetArg,
    scope: writeScopeArg,
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const presetName = typeof args.preset === "string" ? args.preset : "";
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const scope = args.scope === "project" ? "project" : "global";

    if (presetName === PATCH_ALL_PRESET) {
      let failed = false;
      for (const preset of Object.keys(PATCH_PROVIDER_PRESETS) as PatchProviderPresetName[]) {
        try {
          const { result } = await applyPatchProviderPreset(preset, {
            cwd: process.cwd(),
            configDir,
            scope,
          });
          console.log(`${describeWriteResult(result)} (${PATCH_PROVIDER_PRESETS[preset].summary})`);
        } catch (error) {
          failed = true;
          console.error(`${preset}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failed) process.exitCode = 1;
      return;
    }

    const { preset, result } = await applyPatchProviderPreset(presetName, {
      cwd: process.cwd(),
      configDir,
      scope,
    });
    console.log(`${describeWriteResult(result)} (${preset.summary})`);
  },
});
