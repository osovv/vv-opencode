// FILE: src/commands/path-provider.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Apply global OpenCode provider endpoint patch presets.
//   SCOPE: Provider preset validation, global OpenCode config path resolution, baseURL patch writes, and CLI output.
//   DEPENDS: [citty, src/lib/opencode.ts]
//   LINKS: [M-CLI-PATH-PROVIDER, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - PathProvider command definition for vvoc.
//   resolvePathProviderPreset - Validate a provider patch preset name and return its config.
//   applyPathProviderPreset - Apply the selected provider patch preset to global OpenCode config.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.0 - Removed the config-dir flag from the global path-provider command.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { describeWriteResult, resolvePaths, writeProviderBaseUrl } from "../lib/opencode.js";

type ProviderPatchPreset = {
  providerID: string;
  baseURL: string;
};

const PROVIDER_PATCH_PRESETS = {
  "stepfun-ai": {
    providerID: "stepfun",
    baseURL: "https://api.stepfun.ai/v1",
  },
} as const satisfies Record<string, ProviderPatchPreset>;

export type PathProviderPresetName = keyof typeof PROVIDER_PATCH_PRESETS;

const presetArg = {
  type: "positional" as const,
  required: true,
  description: "Provider patch preset to apply.",
};

// START_BLOCK_PROVIDER_PRESET_RESOLUTION
export function resolvePathProviderPreset(name: string): ProviderPatchPreset {
  const presetName = name.trim() as PathProviderPresetName;
  if (presetName in PROVIDER_PATCH_PRESETS) {
    return PROVIDER_PATCH_PRESETS[presetName];
  }

  const supported = Object.keys(PROVIDER_PATCH_PRESETS).join(", ");
  throw new Error(`Unsupported provider patch preset: ${name}. Supported presets: ${supported}`);
}

export async function applyPathProviderPreset(
  presetName: string,
  options: { configDir?: string } = {},
) {
  const preset = resolvePathProviderPreset(presetName);
  const paths = await resolvePaths({ configDir: options.configDir });

  const result = await writeProviderBaseUrl(paths, preset.providerID, preset.baseURL);
  return { preset, result };
}
// END_BLOCK_PROVIDER_PRESET_RESOLUTION

export default defineCommand({
  meta: {
    name: "path-provider",
    description: "Apply a global OpenCode provider patch preset.",
  },
  args: {
    preset: presetArg,
  },
  async run({ args }) {
    const presetName = typeof args.preset === "string" ? args.preset : "";
    const { preset, result } = await applyPathProviderPreset(presetName);

    console.log(
      `${describeWriteResult(result)} (provider.${preset.providerID}.options.baseURL=${preset.baseURL})`,
    );
  },
});
