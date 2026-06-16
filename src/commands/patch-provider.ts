// FILE: src/commands/patch-provider.ts
// VERSION: 0.4.1
// START_MODULE_CONTRACT
//   PURPOSE: Apply OpenCode patch presets to global or project OpenCode config layers.
//   SCOPE: Patch preset validation, scoped OpenCode config path resolution, provider/baseURL patch writes, provider-specific object patch writes under `provider`, and CLI output.
//   DEPENDS: [citty, src/lib/opencode.ts]
//   LINKS: [M-CLI-PATCH-PROVIDER, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - PatchProvider command definition for vvoc.
//   resolvePatchProviderPreset - Validate an OpenCode patch preset name and return its config.
//   PatchProviderPresetName - Supported built-in patch-provider preset names.
//   applyPatchProviderPreset - Apply the selected OpenCode patch preset to global or project OpenCode config.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.5.0 - Added --scope global|project provider patch writes.]
//   LAST_CHANGE: [v0.4.3 - Added reasoning:true to vv-gpt-5.4-xhigh and vv-gpt-5.5-xhigh in openai patch preset.]
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

const STEPFUN_PATCH = {
  options: {
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
      modalities: {
        input: ["text", "image"],
        output: ["text"],
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
      reasoning: true,
      options: {
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    },
    "vv-gpt-5.5-xhigh": {
      name: "VV GPT-5.5-XHigh",
      id: "gpt-5.5",
      variants: {},
      reasoning: true,
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
    kind: "provider-object",
    providerID: "stepfun",
    value: STEPFUN_PATCH,
    summary: "provider.stepfun.models.step-3.7-flash patched + baseURL",
  },
  zai: {
    kind: "provider-object",
    providerID: "zai-coding-plan",
    value: ZAI_CODING_PLAN_PATCH,
    summary: "provider.zai-coding-plan.models.glm-4.5-airx patched",
  },
  openai: {
    kind: "provider-object",
    providerID: "openai",
    value: OPENAI_PATCH,
    summary: "provider.openai.models.vv-gpt-5.5-xhigh patched",
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

const writeScopeArg = {
  type: "enum" as const,
  options: ["global", "project"],
  default: "global",
  description: "Write global config or project-local config.",
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
    const { preset, result } = await applyPatchProviderPreset(presetName, {
      cwd: process.cwd(),
      configDir,
      scope: args.scope === "project" ? "project" : "global",
    });

    console.log(`${describeWriteResult(result)} (${preset.summary})`);
  },
});
