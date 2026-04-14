// FILE: src/lib/agent-models.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Define supported vvoc model target IDs and shared model override validation helpers.
//   SCOPE: Model target ID lists, type guards, model formatting, and model-argument parsing reused by CLI commands and vvoc config validation, including OpenCode agent targets that support variants.
//   DEPENDS: [src/lib/managed-agents.ts]
//   LINKS: [M-CLI-CONFIG, M-CLI-COMMANDS, M-CLI-PRESET]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SPECIAL_AGENT_NAMES - Target IDs that support provider/model[:variant] syntax in canonical vvoc config.
//   OPENCODE_DEFAULT_MODEL_TARGETS - Target IDs that map to top-level OpenCode model fields.
//   CONFIGURABLE_OPENCODE_PRIMARY_AGENTS - Built-in OpenCode primary agent IDs vvoc can override directly.
//   CONFIGURABLE_OPENCODE_SUBAGENTS - Built-in OpenCode subagent IDs vvoc can override directly.
//   CONFIGURABLE_OPENCODE_AGENTS - Built-in OpenCode agent IDs that vvoc can map to model plus variant fields.
//   SupportedModelTargetName - Union of every preset-compatible model target ID.
//   MODEL_TARGET_NAME_CHOICES - Human-readable supported target list for CLI errors.
//   isSpecialAgentName - Checks whether a target uses Guardian-style model syntax.
//   isOpenCodeDefaultModelTargetName - Checks whether a target maps to top-level OpenCode model fields.
//   isConfigurableOpenCodeAgentName - Checks whether a target is a built-in OpenCode agent override.
//   isConfigurableOpenCodeSubagentName - Checks whether a target is a built-in OpenCode agent override.
//   parseModelTargetName - Validates a user-supplied model target ID.
//   parseGuardianStyleModelArg - Validates provider/model[:variant] syntax.
//   parseOpenCodeModelArg - Validates plain provider/model syntax for top-level OpenCode model fields.
//   parseOpenCodeAgentModelArg - Validates provider/model[:variant] syntax for OpenCode agent fields.
//   normalizeModelTargetOverride - Validates and canonicalizes a stored model override string for any supported target.
//   formatAgentModel - Formats a model and optional variant for CLI output.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.3.0 - Added variant-aware OpenCode agent targets for build/plan/general/explore while keeping top-level default model fields plain.]
// END_CHANGE_SUMMARY

import {
  MANAGED_OPENCODE_AGENTS,
  isManagedOpenCodeAgentName,
  type ManagedOpenCodeAgentName,
} from "./managed-agents.js";

export const SPECIAL_AGENT_NAMES = ["guardian", "memory-reviewer"] as const;
export type SpecialAgentName = (typeof SPECIAL_AGENT_NAMES)[number];

export const OPENCODE_DEFAULT_MODEL_TARGETS = ["default", "small-model"] as const;
export type OpenCodeDefaultModelTargetName = (typeof OPENCODE_DEFAULT_MODEL_TARGETS)[number];

export const CONFIGURABLE_OPENCODE_PRIMARY_AGENTS = ["build", "plan"] as const;
export type ConfigurableOpenCodePrimaryAgentName =
  (typeof CONFIGURABLE_OPENCODE_PRIMARY_AGENTS)[number];

export const CONFIGURABLE_OPENCODE_SUBAGENTS = ["general", "explore"] as const;
export type ConfigurableOpenCodeSubagentName = (typeof CONFIGURABLE_OPENCODE_SUBAGENTS)[number];

export const CONFIGURABLE_OPENCODE_AGENTS = [
  ...CONFIGURABLE_OPENCODE_PRIMARY_AGENTS,
  ...CONFIGURABLE_OPENCODE_SUBAGENTS,
] as const;
export type ConfigurableOpenCodeAgentName = (typeof CONFIGURABLE_OPENCODE_AGENTS)[number];

export type SupportedModelTargetName =
  | SpecialAgentName
  | OpenCodeDefaultModelTargetName
  | ConfigurableOpenCodeAgentName
  | ManagedOpenCodeAgentName;

export const SUPPORTED_MODEL_TARGET_NAMES: readonly SupportedModelTargetName[] = [
  ...SPECIAL_AGENT_NAMES,
  ...OPENCODE_DEFAULT_MODEL_TARGETS,
  ...CONFIGURABLE_OPENCODE_AGENTS,
  ...MANAGED_OPENCODE_AGENTS.map((definition) => definition.name),
];

export const MODEL_TARGET_NAME_CHOICES = SUPPORTED_MODEL_TARGET_NAMES.join(", ");

export function isSpecialAgentName(value: string): value is SpecialAgentName {
  return SPECIAL_AGENT_NAMES.includes(value as SpecialAgentName);
}

export function isOpenCodeDefaultModelTargetName(
  value: string,
): value is OpenCodeDefaultModelTargetName {
  return OPENCODE_DEFAULT_MODEL_TARGETS.includes(value as OpenCodeDefaultModelTargetName);
}

export function isConfigurableOpenCodeSubagentName(
  value: string,
): value is ConfigurableOpenCodeSubagentName {
  return CONFIGURABLE_OPENCODE_SUBAGENTS.includes(value as ConfigurableOpenCodeSubagentName);
}

export function isConfigurableOpenCodeAgentName(
  value: string,
): value is ConfigurableOpenCodeAgentName {
  return CONFIGURABLE_OPENCODE_AGENTS.includes(value as ConfigurableOpenCodeAgentName);
}

export function parseModelTargetName(value: unknown, operation: string): SupportedModelTargetName {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`target argument required for ${operation}`);
  }

  const trimmed = value.trim();

  if (
    isSpecialAgentName(trimmed) ||
    isOpenCodeDefaultModelTargetName(trimmed) ||
    isConfigurableOpenCodeAgentName(trimmed) ||
    isManagedOpenCodeAgentName(trimmed)
  ) {
    return trimmed;
  }

  throw new Error(`unsupported target: ${trimmed}. Expected one of: ${MODEL_TARGET_NAME_CHOICES}`);
}

export function parseGuardianStyleModelArg(
  value: unknown,
  operation: string,
): { model: string; variant?: string } {
  return parseModelArgWithOptionalVariant(value, operation);
}

export function parseOpenCodeAgentModelArg(
  value: unknown,
  operation: string,
): { model: string; variant?: string } {
  return parseModelArgWithOptionalVariant(value, operation);
}

function parseModelArgWithOptionalVariant(
  value: unknown,
  operation: string,
): { model: string; variant?: string } {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`model argument required for ${operation}`);
  }

  const trimmed = value.trim();

  if (trimmed.includes(":")) {
    const lastColon = trimmed.lastIndexOf(":");
    const model = trimmed.slice(0, lastColon);
    const variant = trimmed.slice(lastColon + 1);
    if (!model.includes("/")) {
      throw new Error(`model must be in provider/model-id format, got: ${trimmed}`);
    }
    return { model, variant };
  }

  if (!trimmed.includes("/")) {
    throw new Error(`model must be in provider/model-id format, got: ${trimmed}`);
  }

  return { model: trimmed };
}

export function parseOpenCodeModelArg(value: unknown, operation: string): string {
  const { model, variant } = parseModelArgWithOptionalVariant(value, operation);
  if (variant) {
    throw new Error(
      `model must be in provider/model-id format without :variant for ${operation}, got: ${value}`,
    );
  }
  return model;
}

export function normalizeModelTargetOverride(
  targetName: SupportedModelTargetName,
  value: unknown,
  operation: string,
): string {
  if (isSpecialAgentName(targetName)) {
    const { model, variant } = parseGuardianStyleModelArg(value, operation);
    return formatAgentModel(model, variant);
  }

  if (isConfigurableOpenCodeAgentName(targetName) || isManagedOpenCodeAgentName(targetName)) {
    const { model, variant } = parseOpenCodeAgentModelArg(value, operation);
    return formatAgentModel(model, variant);
  }

  return parseOpenCodeModelArg(value, operation);
}

export function formatAgentModel(model?: string, variant?: string): string {
  if (!model) {
    return "default";
  }

  return variant ? `${model}:${variant}` : model;
}
