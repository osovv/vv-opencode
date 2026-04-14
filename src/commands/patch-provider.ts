// FILE: src/commands/patch-provider.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Apply global OpenCode patch presets.
//   SCOPE: Patch preset validation, global OpenCode config path resolution, provider/baseURL patch writes, provider-specific object patch writes under `provider`, optional root default-model writes, and CLI output.
//   INPUTS: CLI preset name plus optional config directory override.
//   OUTPUTS: Global OpenCode config mutations and a one-line write summary.
//   DEPENDS: [citty, src/lib/opencode.ts]
//   LINKS: [M-CLI-PATCH-PROVIDER, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - PatchProvider command definition for vvoc.
//   resolvePatchProviderPreset - Validate an OpenCode patch preset name and return its config.
//   applyPatchProviderPreset - Apply the selected OpenCode patch preset to global OpenCode config.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.3.0 - Added the openai preset that installs a vv-managed GPT-5.4 xhigh alias model and sets it as the global default.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  describeWriteResult,
  resolvePaths,
  writeOpenCodeDefaultModel,
  writeOpenCodeProviderObject,
  writeProviderBaseUrl,
  type WriteResult,
} from "../lib/opencode.js";

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

type ProviderObjectAndDefaultModelPatchPreset = {
  kind: "provider-object-and-default-model";
  providerID: string;
  value: Record<string, unknown>;
  model: string;
  summary: string;
};

type PatchPreset =
  | ProviderBaseUrlPatchPreset
  | ProviderObjectPatchPreset
  | ProviderObjectAndDefaultModelPatchPreset;

const ZAI_CODING_PLAN_PATCH = {
  models: {
    "glm-4.5-airx": {
      "name: glm-4.5-airx": {
        limit: {
          context: 128000,
          output: 96000,
        },
      },
    },
  },
} as const satisfies Record<string, unknown>;

const OPENAI_PATCH = {
  models: {
    "vv-gpt-5.4-xhigh": {
      name: "VV GPT-5.4-XHigh",
      id: "gpt-5.4",
      variants: {},
      options: {
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    },
  },
} as const satisfies Record<string, unknown>;

const PATCH_PROVIDER_PRESETS = {
  "stepfun-ai": {
    kind: "provider-base-url",
    providerID: "stepfun",
    baseURL: "https://api.stepfun.ai/v1",
    summary: "provider.stepfun.options.baseURL=https://api.stepfun.ai/v1",
  },
  zai: {
    kind: "provider-object",
    providerID: "zai-coding-plan",
    value: ZAI_CODING_PLAN_PATCH,
    summary: "provider.zai-coding-plan.models.glm-4.5-airx patched",
  },
  openai: {
    kind: "provider-object-and-default-model",
    providerID: "openai",
    value: OPENAI_PATCH,
    model: "openai/vv-gpt-5.4-xhigh",
    summary:
      "provider.openai.models.vv-gpt-5.4-xhigh patched and model set to openai/vv-gpt-5.4-xhigh",
  },
} as const satisfies Record<string, PatchPreset>;

export type PatchProviderPresetName = keyof typeof PATCH_PROVIDER_PRESETS;

const presetArg = {
  type: "positional" as const,
  required: true,
  description: "OpenCode patch preset to apply.",
};

const configDirArg = {
  type: "string" as const,
  description: "Override the global config home used for opencode/.",
};

// START_BLOCK_PROVIDER_PRESET_RESOLUTION
export function resolvePatchProviderPreset(name: string): PatchPreset {
  const presetName = name.trim() as PatchProviderPresetName;
  if (presetName in PATCH_PROVIDER_PRESETS) {
    return PATCH_PROVIDER_PRESETS[presetName];
  }

  const supported = Object.keys(PATCH_PROVIDER_PRESETS).join(", ");
  throw new Error(`Unsupported OpenCode patch preset: ${name}. Supported presets: ${supported}`);
}

export async function applyPatchProviderPreset(
  presetName: string,
  options: { cwd?: string; configDir?: string } = {},
) {
  const preset = resolvePatchProviderPreset(presetName);
  const paths = await resolvePaths({
    scope: "global",
    cwd: options.cwd ?? process.cwd(),
    configDir: options.configDir,
  });

  const result =
    preset.kind === "provider-base-url"
      ? await writeProviderBaseUrl(paths, preset.providerID, preset.baseURL)
      : preset.kind === "provider-object"
        ? await writeOpenCodeProviderObject(paths, preset.providerID, preset.value)
        : await applyProviderObjectAndDefaultModelPreset(paths, preset);

  return { preset, result };
}

async function applyProviderObjectAndDefaultModelPreset(
  paths: Awaited<ReturnType<typeof resolvePaths>>,
  preset: ProviderObjectAndDefaultModelPatchPreset,
): Promise<WriteResult> {
  const providerResult = await writeOpenCodeProviderObject(paths, preset.providerID, preset.value);
  const modelResult = await writeOpenCodeDefaultModel(paths, "model", {
    model: preset.model,
    ensureEntry: true,
  });

  return coalesceWriteResults(providerResult, modelResult);
}

function coalesceWriteResults(...results: WriteResult[]): WriteResult {
  const path = results[results.length - 1]?.path ?? "";
  if (results.some((result) => result.action === "created")) {
    return { action: "created", path };
  }
  if (results.some((result) => result.action === "updated")) {
    return { action: "updated", path };
  }
  if (results.some((result) => result.action === "skipped")) {
    return { action: "skipped", path };
  }
  return { action: "kept", path };
}
// END_BLOCK_PROVIDER_PRESET_RESOLUTION

export default defineCommand({
  meta: {
    name: "patch-provider",
    description: "Apply a global OpenCode patch preset.",
  },
  args: {
    preset: presetArg,
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const presetName = typeof args.preset === "string" ? args.preset : "";
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const { preset, result } = await applyPatchProviderPreset(presetName, {
      cwd: process.cwd(),
      configDir,
    });

    console.log(`${describeWriteResult(result)} (${preset.summary})`);
  },
});
