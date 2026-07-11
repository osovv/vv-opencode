// FILE: src/lib/vvoc-preset-registry.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the canonical built-in vvoc preset registry from a single internal source of truth.
//   SCOPE: Built-in preset name ordering, role and orchestration definitions, and built-in preset-name detection.
//   DEPENDS: [src/lib/orchestration.ts]
//   LINKS: [M-VVOC-PRESET-REGISTRY, M-ORCHESTRATION-PROFILES, M-CLI-CONFIG, M-CLI-PRESET, M-CLI-COMPLETION]
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
//   LAST_CHANGE: [v0.2.0 - vv-osovv: fast→openai/vv-gpt-5.6-luna-low, smart→openai/vv-gpt-5.6-sol-xhigh; vv-osovv-cheap: fast→openai/vv-gpt-5.6-luna-low, smart→openai/vv-gpt-5.6-terra-high.]
//   LAST_CHANGE: [v0.3.0 - Replaced unavailable GPT-5.6 Luna Low with GPT-5.4 Mini Low for the fast role in both osovv presets.]
//   LAST_CHANGE: [C-CODEX-PRESET-LIMITS - Renamed vv-openai to vv-codex and updated all model references to openai/vv-codex-gpt-* namespace.]
//   LAST_CHANGE: [C-PRESET-ORCHESTRATION-PROFILES - Added an explicit orchestration profile to every managed preset.]
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
      smart: "zai-coding-plan/glm-5.1",
      fast: "zai-coding-plan/glm-4.5-airx",
      vision: "zai-coding-plan/glm-4.6v",
      reviewer: "zai-coding-plan/glm-5.1",
    },
    orchestration: { profile: "balanced" },
  },
  "vv-minimax": {
    description: "Starter MiniMax role assignments for built-in vvoc roles.",
    agents: {
      default: "minimax-coding-plan/MiniMax-M2.7",
      smart: "minimax-coding-plan/MiniMax-M2.7",
      fast: "minimax-coding-plan/MiniMax-M2.1",
      vision: "minimax-coding-plan/MiniMax-M2.7",
      reviewer: "minimax-coding-plan/MiniMax-M2.7",
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
    description: "Personal osovv role assignments (deepseek + openai + minimax + zai).",
    agents: {
      default: "deepseek/deepseek-v4-flash",
      fast: "openai/vv-codex-gpt-5.4-mini-low",
      smart: "openai/vv-codex-gpt-5.6-sol-xhigh",
      vision: "minimax-coding-plan/MiniMax-M2.7",
      reviewer: "zai-coding-plan/glm-5.1",
    },
    orchestration: { profile: "single-session" },
  },
  "vv-osovv-cheap": {
    description: "Cheap osovv role assignments (deepseek + openai + minimax).",
    agents: {
      default: "deepseek/deepseek-v4-flash",
      fast: "openai/vv-codex-gpt-5.4-mini-low",
      smart: "openai/vv-codex-gpt-5.6-terra-high",
      vision: "minimax-coding-plan/MiniMax-M2.7",
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
