// FILE: src/lib/managed-agents.ts
// VERSION: 0.2.1
// START_MODULE_CONTRACT
//   PURPOSE: Describe vvoc-managed OpenCode agent prompts and load them from bundled templates or scoped vvoc config roots.
//   SCOPE: Built-in subagent metadata, managed prompt names, prompt file path resolution, bundled template loading, and project/global prompt lookup.
//   DEPENDS: [node:fs/promises, node:path, src/lib/vvoc-paths.ts]
//   LINKS: [M-CLI-CONFIG, M-PLUGIN-GUARDIAN, M-PLUGIN-MEMORY]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ManagedSubagentName - Canonical vvoc-managed subagent names.
//   ManagedAgentPromptName - Canonical vvoc-managed agent prompt names including Guardian and memory-reviewer.
//   ManagedSubagentDefinition - Metadata used to register a managed subagent in OpenCode config.
//   MANAGED_SUBAGENT_NAMES - Ordered managed subagent names.
//   MANAGED_AGENT_PROMPT_NAMES - Ordered managed agent prompt names.
//   MANAGED_SUBAGENTS - Built-in managed subagent definitions.
//   isManagedSubagentName - Checks whether a string is one of the managed subagent names.
//   getManagedSubagentDefinition - Returns metadata for a managed subagent.
//   getManagedAgentPromptPath - Resolves the prompt file path inside a vvoc agents directory.
//   loadManagedAgentPromptTemplate - Loads the bundled prompt template for a managed agent prompt.
//   loadManagedAgentPromptText - Loads a managed prompt from project or global vvoc config and errors if neither exists.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.1 - Removed explicit steps from vvoc-managed subagents so only guardian keeps a hard step limit.]
// END_CHANGE_SUMMARY

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getGlobalVvocDir, getProjectVvocDir, getVvocAgentsDir } from "./vvoc-paths.js";

export const MANAGED_SUBAGENT_NAMES = [
  "implementer",
  "spec-reviewer",
  "code-reviewer",
  "investitagor",
] as const;

export type ManagedSubagentName = (typeof MANAGED_SUBAGENT_NAMES)[number];
export const MANAGED_AGENT_PROMPT_NAMES = [
  "guardian",
  "memory-reviewer",
  ...MANAGED_SUBAGENT_NAMES,
] as const;

export type ManagedAgentPromptName = (typeof MANAGED_AGENT_PROMPT_NAMES)[number];

export type ManagedSubagentDefinition = {
  name: ManagedSubagentName;
  description: string;
  promptFileName: `${ManagedSubagentName}.md`;
  permission?: Record<string, unknown>;
};

export const MANAGED_SUBAGENTS: readonly ManagedSubagentDefinition[] = [
  {
    name: "implementer",
    description: "Implements approved changes with focused verification and a minimal diff.",
    promptFileName: "implementer.md",
  },
  {
    name: "spec-reviewer",
    description:
      "Checks an implementation against the requested spec and flags missing or extra behavior.",
    promptFileName: "spec-reviewer.md",
    permission: {
      edit: "deny",
    },
  },
  {
    name: "code-reviewer",
    description: "Reviews changes for bugs, regressions, maintainability risks, and missing tests.",
    promptFileName: "code-reviewer.md",
    permission: {
      edit: "deny",
    },
  },
  {
    name: "investitagor",
    description: "Investigates bugs and unclear behavior before implementation work begins.",
    promptFileName: "investitagor.md",
    permission: {
      edit: "deny",
    },
  },
];

const MANAGED_SUBAGENT_MAP = new Map(
  MANAGED_SUBAGENTS.map((definition) => [definition.name, definition]),
);
const MANAGED_AGENT_PROMPT_FILE_NAMES = new Map<
  ManagedAgentPromptName,
  `${ManagedAgentPromptName}.md`
>([
  ["guardian", "guardian.md"],
  ["memory-reviewer", "memory-reviewer.md"],
  ["implementer", "implementer.md"],
  ["spec-reviewer", "spec-reviewer.md"],
  ["code-reviewer", "code-reviewer.md"],
  ["investitagor", "investitagor.md"],
]);

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

export function getManagedAgentPromptPath(
  agentsDirPath: string,
  name: ManagedAgentPromptName,
): string {
  return join(agentsDirPath, getManagedAgentPromptFileName(name));
}

export async function loadManagedAgentPromptTemplate(
  name: ManagedAgentPromptName,
): Promise<string> {
  const assetUrl = new URL(
    `../../templates/agents/${getManagedAgentPromptFileName(name)}`,
    import.meta.url,
  );
  return readFile(assetUrl, "utf8");
}

export async function loadManagedAgentPromptText(
  directory: string,
  name: ManagedAgentPromptName,
): Promise<string> {
  const candidatePaths = [
    getManagedAgentPromptPath(getVvocAgentsDir(getProjectVvocDir(directory)), name),
    getManagedAgentPromptPath(getVvocAgentsDir(getGlobalVvocDir()), name),
  ];

  for (const candidatePath of candidatePaths) {
    try {
      return await readFile(candidatePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `vvoc managed prompt not found for ${name}. Run \`vvoc install\` or \`vvoc sync\`. Checked: ${candidatePaths.join(", ")}`,
  );
}

function getManagedAgentPromptFileName(
  name: ManagedAgentPromptName,
): `${ManagedAgentPromptName}.md` {
  const promptFileName = MANAGED_AGENT_PROMPT_FILE_NAMES.get(name);
  if (!promptFileName) {
    throw new Error(`unknown managed agent prompt: ${name}`);
  }
  return promptFileName;
}
