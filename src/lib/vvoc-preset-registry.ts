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
//   LAST_CHANGE: [v1.2.4 - Dropped vv-minimax and dead zai fast/vision models; vv-zai fast=zai-coding-plan/glm-4.7, vision=openai/gpt-5.4; vv-osovv and vv-osovv-cheap vision=openai/gpt-5.4; zai smart/reviewer roles use the official plan flagship zai-coding-plan/glm-5.2.]
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
      default: "openai/gpt-5.4",
      smart: "openai/vv-codex-gpt-5.5-xhigh",
      fast: "openai/gpt-5.4-mini",
      vision: "openai/gpt-5.4",
      reviewer: "openai/gpt-5.4",
    },
    orchestration: { profile: "single-session" },
  },
  "vv-zai": {
    description: "Starter ZAI role assignments for built-in vvoc roles.",
    agents: {
      default: "zai-coding-plan/glm-5-turbo",
      smart: "zai-coding-plan/glm-5.2",
      fast: "zai-coding-plan/glm-4.7",
      vision: "openai/gpt-5.4",
      reviewer: "zai-coding-plan/glm-5.2",
    },
    orchestration: { profile: "balanced" },
  },
  "vv-deepseek": {
    description: "Starter DeepSeek role assignments for built-in vvoc roles.",
    agents: {
      default: "deepseek/deepseek-v4-flash",
      smart: "deepseek/deepseek-v4-pro",
      fast: "deepseek/deepseek-v4-flash",
      vision: "deepseek/deepseek-v4-pro",
      reviewer: "deepseek/deepseek-v4-pro",
    },
    orchestration: { profile: "balanced" },
  },
  "vv-osovv": {
    description: "Personal osovv role assignments (deepseek + openai + zai).",
    agents: {
      default: "deepseek/deepseek-v4-flash",
      fast: "openai/vv-codex-gpt-5.4-mini-low",
      smart: "openai/vv-codex-gpt-5.6-sol-xhigh",
      vision: "openai/gpt-5.4",
      reviewer: "zai-coding-plan/glm-5.2",
    },
    orchestration: { profile: "single-session" },
  },
  "vv-osovv-cheap": {
    description: "Cheap osovv role assignments (deepseek + openai).",
    agents: {
      default: "deepseek/deepseek-v4-flash",
      fast: "openai/vv-codex-gpt-5.4-mini-low",
      smart: "openai/vv-codex-gpt-5.6-terra-high",
      vision: "openai/gpt-5.4",
      reviewer: "deepseek/deepseek-v4-pro",
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
