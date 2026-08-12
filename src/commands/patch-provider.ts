// FILE: src/commands/patch-provider.ts
// VERSION: 0.8.0
// START_MODULE_CONTRACT
//   PURPOSE: Apply OpenCode patch presets to global or project OpenCode config layers.
//   SCOPE: Patch preset validation, scoped OpenCode config path resolution, provider/baseURL patch writes, provider-specific object patch writes under `provider`, and CLI output.
//   DEPENDS: [citty, src/lib/opencode.ts]
//   LINKS: M-CLI-PATCH-PROVIDER, M-CLI-CONFIG
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
//   LAST_CHANGE: [v1.2.4 - Added vv-codex-gpt-5.6-luna-low to the openai patch, new kimi/alibaba alias patches, and the `all` preset that patches every provider at once.]
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
    "vv-codex-gpt-5.4-mini-low": {
      name: "VV Codex GPT-5.4 Mini Low",
      id: "gpt-5.4-mini",
      variants: {},
      limit: {
        context: 400000,
        input: 272000,
        output: 128000,
      },
      reasoning: true,
      options: {
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    },
    "vv-codex-gpt-5.5-xhigh": {
      name: "VV Codex GPT-5.5-XHigh",
      id: "gpt-5.5",
      variants: {},
      limit: {
        context: 400000,
        input: 272000,
        output: 128000,
      },
      reasoning: true,
      options: {
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    },
    "vv-codex-gpt-5.6-terra-high": {
      name: "VV Codex GPT-5.6 Terra High",
      id: "gpt-5.6-terra",
      variants: {},
      limit: {
        context: 400000,
        input: 272000,
        output: 128000,
      },
      reasoning: true,
      options: {
        reasoningEffort: "high",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    },
    "vv-codex-gpt-5.6-sol-xhigh": {
      name: "VV Codex GPT-5.6 Sol XHigh",
      id: "gpt-5.6-sol",
      variants: {},
      limit: {
        context: 400000,
        input: 272000,
        output: 128000,
      },
      reasoning: true,
      options: {
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    },
    "vv-codex-gpt-5.6-luna-low": {
      name: "VV Codex GPT-5.6 Luna Low",
      id: "gpt-5.6-luna",
      variants: {},
      limit: {
        context: 400000,
        input: 272000,
        output: 128000,
      },
      reasoning: true,
      options: {
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    },
  },
} as const satisfies Record<string, unknown>;

const KIMI_PATCH = {
  models: {
    "vv-kimi-k3-max": {
      name: "VV Kimi K3 Max",
      id: "kimi-k3",
      variants: {},
      limit: {
        context: 1000000,
        output: 1000000,
      },
      reasoning: true,
      options: {
        reasoningEffort: "max",
      },
    },
  },
} as const satisfies Record<string, unknown>;

const ALIBABA_PATCH = {
  models: {
    "vv-qwen3.8-max-xhigh": {
      name: "VV Qwen3.8-Max XHigh",
      id: "qwen3.8-max",
      variants: {},
      limit: {
        context: 1000000,
        output: 131072,
      },
      reasoning: true,
      options: {
        reasoningEffort: "xhigh",
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
  codex: {
    kind: "provider-object",
    providerID: "openai",
    value: OPENAI_PATCH,
    summary: "provider.openai.models vv-codex-gpt-5.4/5.5/5.6 aliases patched",
  },
  kimi: {
    kind: "provider-object",
    providerID: "moonshotai",
    value: KIMI_PATCH,
    summary: "provider.moonshotai.models.vv-kimi-k3-max patched",
  },
  alibaba: {
    kind: "provider-object",
    providerID: "alibaba-token-plan",
    value: ALIBABA_PATCH,
    summary: "provider.alibaba-token-plan.models.vv-qwen3.8-max-xhigh patched",
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
