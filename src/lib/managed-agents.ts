// FILE: src/lib/managed-agents.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Describe vvoc-managed OpenCode subagents and load their bundled prompt templates.
//   SCOPE: Built-in subagent metadata, name validation, definition lookup, and template file loading from package assets.
//   DEPENDS: [node:fs/promises]
//   LINKS: [M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ManagedSubagentName - Canonical vvoc-managed subagent names.
//   ManagedSubagentDefinition - Metadata used to register a managed subagent in OpenCode config.
//   MANAGED_SUBAGENT_NAMES - Ordered managed subagent names.
//   MANAGED_SUBAGENTS - Built-in managed subagent definitions.
//   isManagedSubagentName - Checks whether a string is one of the managed subagent names.
//   getManagedSubagentDefinition - Returns metadata for a managed subagent.
//   loadManagedSubagentTemplate - Loads the bundled prompt template for a managed subagent.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added bundled metadata and asset-backed prompt loading for vvoc-managed subagents.]
// END_CHANGE_SUMMARY

import { readFile } from "node:fs/promises";

export const MANAGED_SUBAGENT_NAMES = [
  "implementer",
  "spec-reviewer",
  "code-reviewer",
  "investitagor",
] as const;

export type ManagedSubagentName = (typeof MANAGED_SUBAGENT_NAMES)[number];

export type ManagedSubagentDefinition = {
  name: ManagedSubagentName;
  description: string;
  promptFileName: `${ManagedSubagentName}.md`;
  steps?: number;
  permission?: Record<string, unknown>;
};

export const MANAGED_SUBAGENTS: readonly ManagedSubagentDefinition[] = [
  {
    name: "implementer",
    description: "Implements approved changes with focused verification and a minimal diff.",
    promptFileName: "implementer.md",
    steps: 8,
  },
  {
    name: "spec-reviewer",
    description:
      "Checks an implementation against the requested spec and flags missing or extra behavior.",
    promptFileName: "spec-reviewer.md",
    steps: 6,
    permission: {
      edit: "deny",
    },
  },
  {
    name: "code-reviewer",
    description: "Reviews changes for bugs, regressions, maintainability risks, and missing tests.",
    promptFileName: "code-reviewer.md",
    steps: 6,
    permission: {
      edit: "deny",
    },
  },
  {
    name: "investitagor",
    description: "Investigates bugs and unclear behavior before implementation work begins.",
    promptFileName: "investitagor.md",
    steps: 6,
    permission: {
      edit: "deny",
    },
  },
];

const MANAGED_SUBAGENT_MAP = new Map(
  MANAGED_SUBAGENTS.map((definition) => [definition.name, definition]),
);

export function isManagedSubagentName(value: string): value is ManagedSubagentName {
  return MANAGED_SUBAGENT_MAP.has(value as ManagedSubagentName);
}

export function getManagedSubagentDefinition(name: ManagedSubagentName): ManagedSubagentDefinition {
  const definition = MANAGED_SUBAGENT_MAP.get(name);
  if (!definition) {
    throw new Error(`unknown managed subagent: ${name}`);
  }
  return definition;
}

export async function loadManagedSubagentTemplate(name: ManagedSubagentName): Promise<string> {
  const definition = getManagedSubagentDefinition(name);
  const assetUrl = new URL(`../../templates/agents/${definition.promptFileName}`, import.meta.url);
  return readFile(assetUrl, "utf8");
}
