// FILE: src/lib/vvoc-preset-registry.ts
// VERSION: 0.5.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the canonical built-in vvoc preset registry from a single internal source of truth.
//   SCOPE: Built-in preset name ordering, role definitions, and built-in preset-name detection; presets never select execution behavior.
//   DEPENDS: [none]
//   LINKS: M-VVOC-PRESET-REGISTRY, M-CLI-CONFIG, M-CLI-PRESET, M-CLI-COMPLETION
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
//   LAST_CHANGE: [C-REMOVE-SESSION-ORCHESTRATION-PROFILES T-002 - Presets declare role assignments only; orchestration profiles are no longer part of any built-in preset.]
// END_CHANGE_SUMMARY

type BuiltinVvocPresetDefinition = {
  description: string;
  agents: Record<string, string>;
};

export const BUILTIN_VVOC_PRESET_REGISTRY = {
  "vv-codex": {
    description: "Starter Codex subscription role assignments for built-in vvoc roles.",
    agents: {
      default: "openai/gpt-5.6-terra#high",
      fast: "openai/gpt-6-luna#low",
      smart: "openai/gpt-5.6-sol#xhigh",
      reviewer: "openai/gpt-5.6-sol#xhigh",
    },
  },
  "vv-zai": {
    description: "Starter ZAI role assignments for built-in vvoc roles.",
    agents: {
      default: "zai-coding-plan/glm-5.3-flash#max",
      fast: "zai-coding-plan/glm-5.3-flash#max",
      smart: "zai-coding-plan/glm-5.3#max",
      reviewer: "zai-coding-plan/glm-5.3#max",
    },
  },
  "vv-deepseek": {
    description: "Starter DeepSeek role assignments for built-in vvoc roles.",
    agents: {
      default: "deepseek/deepseek-flash#max",
      fast: "deepseek/deepseek-flash#max",
      smart: "deepseek/deepseek-flash#max",
      reviewer: "deepseek/deepseek-flash#max",
    },
  },
  "vv-alibaba": {
    description: "Starter Alibaba token plan role assignments for built-in vvoc roles.",
    agents: {
      default: "alibaba-token-plan/qwen3.8-max",
      fast: "alibaba-token-plan/deepseek-v4-flash",
      smart: "alibaba-token-plan/qwen3.8-max#xhigh",
      reviewer: "alibaba-token-plan/glm-5.2",
    },
  },
  "vv-osovv-ds": {
    description:
      "Personal osovv stack with DeepSeek Flash default and smart (deepseek + openai + zai).",
    agents: {
      default: "deepseek/deepseek-flash#max",
      fast: "openai/gpt-6-luna#low",
      smart: "deepseek/deepseek-flash#max",
      reviewer: "zai-coding-plan/glm-5.3#max",
    },
  },
  "vv-osovv-mimo": {
    description:
      "Personal osovv stack with MiMo Flash High default and smart (mimo + openai + zai).",
    agents: {
      default: "xiaomi/mimo-v2.6-flash#thinking",
      fast: "openai/gpt-6-luna#low",
      smart: "xiaomi/mimo-v2.6-flash#thinking",
      reviewer: "zai-coding-plan/glm-5.3#max",
    },
  },
  "vv-osovv-zai": {
    description: "Personal osovv stack with GLM-5.3 smart (mimo + openai + zai).",
    agents: {
      default: "xiaomi/mimo-v2.6-flash#thinking",
      fast: "openai/gpt-6-luna#low",
      smart: "zai-coding-plan/glm-5.3#max",
      reviewer: "zai-coding-plan/glm-5.3#max",
    },
  },
  "vv-osovv-qwen": {
    description: "Personal osovv stack with qwen3.8 smart (mimo + openai + qwen + zai).",
    agents: {
      default: "xiaomi/mimo-v2.6-flash#thinking",
      fast: "openai/gpt-6-luna#low",
      smart: "alibaba-token-plan/qwen3.8-max#xhigh",
      reviewer: "zai-coding-plan/glm-5.3#max",
    },
  },
  "vv-astra-solo": {
    description: "Astra-smart solo stack with MiMo default, Luna fast, and GLM-5.3 review.",
    agents: {
      default: "xiaomi/mimo-v2.6-flash#thinking",
      fast: "openai/gpt-6-luna#low",
      smart: "openai/gpt-6-astra#max",
      reviewer: "zai-coding-plan/glm-5.3#high",
    },
  },
  "vv-astra-workers": {
    description: "Astra-architecture delegated stack with MiMo Flash workers and GLM-5.3 review.",
    agents: {
      default: "xiaomi/mimo-v2.6-flash#thinking",
      fast: "openai/gpt-6-luna#low",
      smart: "openai/gpt-6-astra#max",
      reviewer: "zai-coding-plan/glm-5.3#high",
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
