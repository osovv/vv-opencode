// FILE: src/lib/agent-models.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Define supported vvoc agent IDs and shared model override validation helpers.
//   SCOPE: Agent ID lists, type guards, model formatting, and model-argument parsing reused by CLI commands and vvoc config validation.
//   DEPENDS: [src/lib/managed-agents.ts]
//   LINKS: [M-CLI-CONFIG, M-CLI-COMMANDS, M-CLI-PRESET]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SPECIAL_AGENT_NAMES - Agent IDs that support provider/model[:variant] syntax.
//   CONFIGURABLE_OPENCODE_SUBAGENTS - Built-in OpenCode agent IDs vvoc can override directly.
//   SupportedAgentName - Union of every preset-compatible agent ID.
//   AGENT_NAME_CHOICES - Human-readable supported agent list for CLI errors.
//   isSpecialAgentName - Checks whether an agent uses Guardian-style model syntax.
//   isConfigurableOpenCodeSubagentName - Checks whether an agent is a built-in OpenCode target.
//   parseAgentName - Validates a user-supplied agent ID.
//   parseGuardianStyleModelArg - Validates provider/model[:variant] syntax.
//   parseOpenCodeModelArg - Validates provider/model syntax.
//   normalizeAgentModelOverride - Validates and canonicalizes a stored model override string for any supported agent.
//   formatAgentModel - Formats a model and optional variant for CLI output.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added shared agent ID and model validation helpers for agent and preset commands.]
// END_CHANGE_SUMMARY

import {
  MANAGED_OPENCODE_AGENTS,
  isManagedOpenCodeAgentName,
  type ManagedOpenCodeAgentName,
} from "./managed-agents.js";

export const SPECIAL_AGENT_NAMES = ["guardian", "memory-reviewer"] as const;
export type SpecialAgentName = (typeof SPECIAL_AGENT_NAMES)[number];

export const CONFIGURABLE_OPENCODE_SUBAGENTS = ["general", "explore"] as const;
export type ConfigurableOpenCodeSubagentName = (typeof CONFIGURABLE_OPENCODE_SUBAGENTS)[number];

export type SupportedAgentName =
  | SpecialAgentName
  | ConfigurableOpenCodeSubagentName
  | ManagedOpenCodeAgentName;

export const SUPPORTED_AGENT_NAMES: readonly SupportedAgentName[] = [
  ...SPECIAL_AGENT_NAMES,
  ...CONFIGURABLE_OPENCODE_SUBAGENTS,
  ...MANAGED_OPENCODE_AGENTS.map((definition) => definition.name),
];

export const AGENT_NAME_CHOICES = SUPPORTED_AGENT_NAMES.join(", ");

export function isSpecialAgentName(value: string): value is SpecialAgentName {
  return SPECIAL_AGENT_NAMES.includes(value as SpecialAgentName);
}

export function isConfigurableOpenCodeSubagentName(
  value: string,
): value is ConfigurableOpenCodeSubagentName {
  return CONFIGURABLE_OPENCODE_SUBAGENTS.includes(value as ConfigurableOpenCodeSubagentName);
}

export function parseAgentName(value: unknown, operation: string): SupportedAgentName {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`agent argument required for ${operation}`);
  }

  const trimmed = value.trim();

  if (
    isSpecialAgentName(trimmed) ||
    isConfigurableOpenCodeSubagentName(trimmed) ||
    isManagedOpenCodeAgentName(trimmed)
  ) {
    return trimmed;
  }

  throw new Error(`unsupported agent: ${trimmed}. Expected one of: ${AGENT_NAME_CHOICES}`);
}

export function parseGuardianStyleModelArg(
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
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`model argument required for ${operation}`);
  }

  const trimmed = value.trim();
  if (!trimmed.includes("/")) {
    throw new Error(`model must be in provider/model-id format, got: ${trimmed}`);
  }

  return trimmed;
}

export function normalizeAgentModelOverride(
  agentName: SupportedAgentName,
  value: unknown,
  operation: string,
): string {
  if (isSpecialAgentName(agentName)) {
    const { model, variant } = parseGuardianStyleModelArg(value, operation);
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
