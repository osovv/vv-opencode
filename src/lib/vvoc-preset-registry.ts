// FILE: src/lib/vvoc-preset-registry.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the canonical built-in vvoc preset registry from a single internal source of truth.
//   SCOPE: Built-in preset name ordering, preset definitions, and built-in preset-name detection.
//   INPUTS: none
//   OUTPUTS: Canonical built-in preset registry constants and name-guard helpers.
//   DEPENDS: [none]
//   LINKS: [M-VVOC-PRESET-REGISTRY, M-CLI-CONFIG, M-CLI-PRESET, M-CLI-COMPLETION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   BUILTIN_VVOC_PRESET_REGISTRY - Canonical built-in preset definitions keyed by managed preset name.
//   BUILTIN_VVOC_PRESET_NAMES - Canonical built-in preset names in deterministic completion/write order.
//   BuiltInVvocPresetName - Union of built-in managed preset names.
//   isBuiltinVvocPresetName - Checks whether a preset name is a managed built-in key.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added a shared built-in vvoc preset registry so config sync and completions use one source of truth.]
// END_CHANGE_SUMMARY

type BuiltinVvocPresetDefinition = {
  description: string;
  agents: Record<string, string>;
};

export const BUILTIN_VVOC_PRESET_REGISTRY = {
  "vv-openai": {
    description: "Starter OpenAI role assignments for built-in vvoc roles.",
    agents: {
      default: "openai/gpt-5.4",
      smart: "openai/vv-gpt-5.5-xhigh",
      fast: "openai/gpt-5.4-mini",
      vision: "openai/gpt-5.4",
    },
  },
  "vv-zai": {
    description: "Starter ZAI role assignments for built-in vvoc roles.",
    agents: {
      default: "zai-coding-plan/glm-5-turbo",
      smart: "zai-coding-plan/glm-5.1",
      fast: "zai-coding-plan/glm-4.5-airx",
      vision: "zai-coding-plan/glm-4.6v",
    },
  },
  "vv-minimax": {
    description: "Starter MiniMax role assignments for built-in vvoc roles.",
    agents: {
      default: "minimax-coding-plan/MiniMax-M2.7",
      smart: "minimax-coding-plan/MiniMax-M2.7",
      fast: "minimax-coding-plan/MiniMax-M2.1",
      vision: "minimax-coding-plan/MiniMax-M2.7",
    },
  },
  "vv-deepseek": {
    description: "Starter DeepSeek role assignments for built-in vvoc roles.",
    agents: {
      default: "deepseek/deepseek-v4-flash",
      smart: "deepseek/deepseek-v4-pro",
      fast: "deepseek/deepseek-v4-flash",
      vision: "deepseek/deepseek-v4-pro",
    },
  },
  "vv-osovv": {
    description: "Personal osovv role assignments (deepseek + stepfun + minimax).",
    agents: {
      default: "deepseek/deepseek-v4-flash",
      fast: "stepfun/step-3.5-flash",
      smart: "deepseek/deepseek-v4-pro",
      vision: "minimax-coding-plan/MiniMax-M2.7",
    },
  },
} as const satisfies Record<string, BuiltinVvocPresetDefinition>;

export type BuiltInVvocPresetName = keyof typeof BUILTIN_VVOC_PRESET_REGISTRY;

export const BUILTIN_VVOC_PRESET_NAMES = Object.freeze(
  Object.keys(BUILTIN_VVOC_PRESET_REGISTRY) as BuiltInVvocPresetName[],
);

// START_CONTRACT: isBuiltinVvocPresetName
//   PURPOSE: Check whether a preset name belongs to the managed built-in preset registry.
//   INPUTS: { name: string - Candidate preset name. }
//   OUTPUTS: { boolean - True only when the name matches a managed built-in preset key. }
//   SIDE_EFFECTS: none
//   LINKS: [const-BUILTIN_VVOC_PRESET_REGISTRY]
// END_CONTRACT: isBuiltinVvocPresetName
export function isBuiltinVvocPresetName(name: string): name is BuiltInVvocPresetName {
  return Object.hasOwn(BUILTIN_VVOC_PRESET_REGISTRY, name);
}
