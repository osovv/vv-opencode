// FILE: src/lib/managed-agents.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Describe vvoc-managed OpenCode agent prompts and load them from bundled templates or scoped vvoc config roots.
//   SCOPE: Built-in primary/subagent metadata, managed prompt names, prompt file path resolution, bundled template loading, and project/global prompt lookup.
//   DEPENDS: [node:fs/promises, node:path, src/lib/vvoc-paths.ts]
//   LINKS: [M-CLI-CONFIG, M-PLUGIN-GUARDIAN, M-PLUGIN-MEMORY]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ManagedSubagentName - Canonical vvoc-managed subagent names.
//   ManagedPrimaryAgentName - Canonical vvoc-managed primary agent names.
//   ManagedOpenCodeAgentName - Canonical vvoc-managed OpenCode agent registration names.
//   ManagedAgentPromptName - Canonical vvoc-managed agent prompt names including Guardian and memory-reviewer.
//   ManagedSubagentDefinition - Metadata used to register a managed subagent in OpenCode config.
//   ManagedPrimaryAgentDefinition - Metadata used to register a managed primary agent in OpenCode config.
//   MANAGED_SUBAGENT_NAMES - Ordered managed subagent names.
//   MANAGED_PRIMARY_AGENT_NAMES - Ordered managed primary agent names.
//   MANAGED_OPENCODE_AGENT_NAMES - Ordered managed OpenCode agent registration names.
//   MANAGED_AGENT_PROMPT_NAMES - Ordered managed agent prompt names.
//   MANAGED_SUBAGENTS - Built-in managed subagent definitions.
//   MANAGED_PRIMARY_AGENTS - Built-in managed primary agent definitions.
//   MANAGED_OPENCODE_AGENTS - Built-in managed OpenCode agent definitions.
//   isManagedSubagentName - Checks whether a string is one of the managed subagent names.
//   isManagedOpenCodeAgentName - Checks whether a string is one of the managed OpenCode agent names.
//   getManagedSubagentDefinition - Returns metadata for a managed subagent.
//   getManagedOpenCodeAgentDefinition - Returns metadata for a managed OpenCode agent.
//   getManagedAgentPromptPath - Resolves the prompt file path inside a vvoc agents directory.
//   loadManagedAgentPromptTemplate - Loads the bundled prompt template for a managed agent prompt.
//   loadManagedAgentPromptText - Loads a managed prompt from project or global vvoc config and errors if neither exists.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.0 - Added managed vv-controller, vv-analyst, and vv-architect agents for controller-led workflow orchestration.]
//   LAST_CHANGE: [v0.3.1 - Renamed tracked subagents to vv-* names and aligned managed prompt file names with the tracked-agent naming convention.]
//   LAST_CHANGE: [v0.3.0 - Added the managed enhancer primary agent alongside the existing vvoc subagent definitions.]
// END_CHANGE_SUMMARY

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getGlobalVvocDir, getProjectVvocDir, getVvocAgentsDir } from "./vvoc-paths.js";

export const MANAGED_SUBAGENT_NAMES = [
  "vv-analyst",
  "vv-architect",
  "vv-implementer",
  "vv-spec-reviewer",
  "vv-code-reviewer",
  "investigator",
] as const;

export type ManagedSubagentName = (typeof MANAGED_SUBAGENT_NAMES)[number];
export const MANAGED_PRIMARY_AGENT_NAMES = ["vv-controller", "enhancer"] as const;

export type ManagedPrimaryAgentName = (typeof MANAGED_PRIMARY_AGENT_NAMES)[number];
export const MANAGED_OPENCODE_AGENT_NAMES = [
  ...MANAGED_PRIMARY_AGENT_NAMES,
  ...MANAGED_SUBAGENT_NAMES,
] as const;

export type ManagedOpenCodeAgentName = (typeof MANAGED_OPENCODE_AGENT_NAMES)[number];
export const MANAGED_AGENT_PROMPT_NAMES = [
  "guardian",
  "memory-reviewer",
  ...MANAGED_OPENCODE_AGENT_NAMES,
] as const;

export type ManagedAgentPromptName = (typeof MANAGED_AGENT_PROMPT_NAMES)[number];

export type ManagedSubagentDefinition = {
  name: ManagedSubagentName;
  description: string;
  promptFileName: `${ManagedSubagentName}.md`;
  mode: "subagent";
  permission?: Record<string, unknown>;
};

export type ManagedPrimaryAgentDefinition = {
  name: ManagedPrimaryAgentName;
  description: string;
  promptFileName: `${ManagedPrimaryAgentName}.md`;
  mode: "primary";
  permission?: Record<string, unknown>;
};

export const MANAGED_SUBAGENTS: readonly ManagedSubagentDefinition[] = [
  {
    name: "vv-analyst",
    description:
      "Analyzes ambiguous or large requests into requirements, acceptance criteria, and non-goals.",
    promptFileName: "vv-analyst.md",
    mode: "subagent",
    permission: {
      edit: {
        "*": "deny",
        ".vvoc/plans/**": "allow",
      },
      bash: "deny",
      task: "deny",
      todowrite: "deny",
    },
  },
  {
    name: "vv-architect",
    description:
      "Designs module boundaries, contracts, implementation waves, and verification gates for large changes.",
    promptFileName: "vv-architect.md",
    mode: "subagent",
    permission: {
      edit: {
        "*": "deny",
        ".vvoc/plans/**": "allow",
      },
      bash: "deny",
      task: "deny",
      todowrite: "deny",
    },
  },
  {
    name: "vv-implementer",
    description: "Implements approved changes with focused verification and a minimal diff.",
    promptFileName: "vv-implementer.md",
    mode: "subagent",
  },
  {
    name: "vv-spec-reviewer",
    description:
      "Checks an implementation against the requested spec and flags missing or extra behavior.",
    promptFileName: "vv-spec-reviewer.md",
    mode: "subagent",
    permission: {
      edit: "deny",
    },
  },
  {
    name: "vv-code-reviewer",
    description: "Reviews changes for bugs, regressions, maintainability risks, and missing tests.",
    promptFileName: "vv-code-reviewer.md",
    mode: "subagent",
    permission: {
      edit: "deny",
    },
  },
  {
    name: "investigator",
    description: "Investigates bugs and unclear behavior before implementation work begins.",
    promptFileName: "investigator.md",
    mode: "subagent",
    permission: {
      edit: "deny",
    },
  },
];

export const MANAGED_PRIMARY_AGENTS: readonly ManagedPrimaryAgentDefinition[] = [
  {
    name: "vv-controller",
    description:
      "Default vvoc workflow controller for routing, implementation, review, and verification.",
    promptFileName: "vv-controller.md",
    mode: "primary",
  },
  {
    name: "enhancer",
    description: "Turns raw user intent into a structured XML prompt for a follow-up agent.",
    promptFileName: "enhancer.md",
    mode: "primary",
    permission: {
      edit: "deny",
      bash: "deny",
      task: "deny",
      todowrite: "deny",
    },
  },
];

export const MANAGED_OPENCODE_AGENTS = [...MANAGED_PRIMARY_AGENTS, ...MANAGED_SUBAGENTS] as const;

const MANAGED_SUBAGENT_MAP = new Map(
  MANAGED_SUBAGENTS.map((definition) => [definition.name, definition]),
);
const MANAGED_OPENCODE_AGENT_MAP = new Map(
  MANAGED_OPENCODE_AGENTS.map((definition) => [definition.name, definition]),
);
const MANAGED_AGENT_PROMPT_FILE_NAMES = new Map<
  ManagedAgentPromptName,
  `${ManagedAgentPromptName}.md`
>([
  ["guardian", "guardian.md"],
  ["memory-reviewer", "memory-reviewer.md"],
  ["vv-controller", "vv-controller.md"],
  ["enhancer", "enhancer.md"],
  ["vv-analyst", "vv-analyst.md"],
  ["vv-architect", "vv-architect.md"],
  ["vv-implementer", "vv-implementer.md"],
  ["vv-spec-reviewer", "vv-spec-reviewer.md"],
  ["vv-code-reviewer", "vv-code-reviewer.md"],
  ["investigator", "investigator.md"],
]);

export function isManagedSubagentName(value: string): value is ManagedSubagentName {
  return MANAGED_SUBAGENT_MAP.has(value as ManagedSubagentName);
}

export function isManagedOpenCodeAgentName(value: string): value is ManagedOpenCodeAgentName {
  return MANAGED_OPENCODE_AGENT_MAP.has(value as ManagedOpenCodeAgentName);
}

export function getManagedSubagentDefinition(name: ManagedSubagentName): ManagedSubagentDefinition {
  const definition = MANAGED_SUBAGENT_MAP.get(name);
  if (!definition) {
    throw new Error(`unknown managed subagent: ${name}`);
  }
  return definition;
}

export function getManagedOpenCodeAgentDefinition(
  name: ManagedOpenCodeAgentName,
): ManagedPrimaryAgentDefinition | ManagedSubagentDefinition {
  const definition = MANAGED_OPENCODE_AGENT_MAP.get(name);
  if (!definition) {
    throw new Error(`unknown managed OpenCode agent: ${name}`);
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
