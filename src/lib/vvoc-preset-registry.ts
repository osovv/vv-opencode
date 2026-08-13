// FILE: src/lib/vvoc-preset-registry.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the canonical built-in vvoc preset registry from a single internal source of truth.
//   SCOPE: Built-in preset name ordering, role and orchestration definitions, and built-in preset-name detection.
//   DEPENDS: [src/lib/orchestration.ts]
//   LINKS: M-VVOC-PRESET-REGISTRY, M-ORCHESTRATION-PROFILES, M-CLI-CONFIG, M-CLI-PRESET, M-CLI-COMPLETION
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
//   LAST_CHANGE: [v1.2.6 - vv-osovv-flash smart switches to the deepseek/vv-deepseek-v4-flash-max reasoning-effort alias.]
// END_CHANGE_SUMMARY

import type { OrchestrationConfig } from "./orchestration.js";

type BuiltinVvocPresetDefinition = {
  description: string;
  agents: Record<string, string>;
  orchestration: OrchestrationConfig;
};

export const BUILTIN_VVOC_PRESET_REGISTRY = {
  "vv-codex": {
    description: "Starter Codex subscription role assignments for built-in vvoc roles.",
    agents: {
      default: "openai/vv-codex-gpt-5.6-terra-high",
      fast: "openai/vv-codex-gpt-5.6-luna-low",
      smart: "openai/vv-codex-gpt-5.6-sol-xhigh",
      reviewer: "openai/vv-codex-gpt-5.6-sol-xhigh",
    },
    orchestration: { profile: "single-session" },
  },
  "vv-zai": {
    description: "Starter ZAI role assignments for built-in vvoc roles.",
    agents: {
      default: "zai-coding-plan/glm-5-turbo",
      fast: "zai-coding-plan/glm-4.7",
      smart: "zai-coding-plan/glm-5.2",
      reviewer: "zai-coding-plan/glm-5.2",
    },
    orchestration: { profile: "balanced" },
  },
  "vv-deepseek": {
    description: "Starter DeepSeek role assignments for built-in vvoc roles.",
    agents: {
      default: "deepseek/deepseek-v4-flash",
      fast: "deepseek/deepseek-v4-flash",
      smart: "deepseek/deepseek-v4-pro",
      reviewer: "deepseek/deepseek-v4-pro",
    },
    orchestration: { profile: "balanced" },
  },
  "vv-kimi": {
    description: "Starter Moonshot role assignments for built-in vvoc roles.",
    agents: {
      default: "moonshotai/kimi-k3",
      fast: "moonshotai/kimi-k2.7-code-highspeed",
      smart: "moonshotai/vv-kimi-k3-max",
      reviewer: "moonshotai/kimi-k2.7-code",
    },
    orchestration: { profile: "single-session" },
  },
  "vv-alibaba": {
    description: "Starter Alibaba token plan role assignments for built-in vvoc roles.",
    agents: {
      default: "alibaba-token-plan/qwen3.8-max",
      fast: "alibaba-token-plan/deepseek-v4-flash",
      smart: "alibaba-token-plan/vv-qwen3.8-max-xhigh",
      reviewer: "alibaba-token-plan/glm-5.2",
    },
    orchestration: { profile: "single-session" },
  },
  "vv-osovv-sol": {
    description: "Personal osovv stack with codex sol smart (deepseek + openai + zai).",
    agents: {
      default: "deepseek/deepseek-v4-flash",
      fast: "openai/vv-codex-gpt-5.6-luna-low",
      smart: "openai/vv-codex-gpt-5.6-sol-xhigh",
      reviewer: "zai-coding-plan/glm-5.2",
    },
    orchestration: { profile: "single-session" },
  },
  "vv-osovv-flash": {
    description: "Personal osovv stack with deepseek v4 flash smart (deepseek + openai + zai).",
    agents: {
      default: "deepseek/deepseek-v4-flash",
      fast: "openai/vv-codex-gpt-5.6-luna-low",
      smart: "deepseek/vv-deepseek-v4-flash-max",
      reviewer: "zai-coding-plan/glm-5.2",
    },
    orchestration: { profile: "single-session" },
  },
  "vv-osovv-kimi": {
    description: "Personal osovv stack with kimi k3 smart (deepseek + openai + kimi + zai).",
    agents: {
      default: "deepseek/deepseek-v4-flash",
      fast: "openai/vv-codex-gpt-5.6-luna-low",
      smart: "moonshotai/vv-kimi-k3-max",
      reviewer: "zai-coding-plan/glm-5.2",
    },
    orchestration: { profile: "single-session" },
  },
  "vv-osovv-qwen": {
    description: "Personal osovv stack with qwen3.8 smart (deepseek + openai + qwen + zai).",
    agents: {
      default: "deepseek/deepseek-v4-flash",
      fast: "openai/vv-codex-gpt-5.6-luna-low",
      smart: "alibaba-token-plan/vv-qwen3.8-max-xhigh",
      reviewer: "zai-coding-plan/glm-5.2",
    },
    orchestration: { profile: "single-session" },
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
