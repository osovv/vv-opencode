// FILE: src/commands/agent.ts
// VERSION: 0.7.0
// START_MODULE_CONTRACT
//   PURPOSE: Manage model overrides for vvoc-owned and selected built-in OpenCode agents.
//   SCOPE: Guardian and memory-reviewer section writes within canonical vvoc.json plus built-in and managed OpenCode agent model set/unset/list operations via the vvoc agent command tree.
//   DEPENDS: [citty, src/lib/managed-agents.ts, src/lib/opencode.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Agent command group.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.7.0 - Removed scope/config-dir options from agent model management.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  MANAGED_OPENCODE_AGENTS,
  isManagedOpenCodeAgentName,
  type ManagedOpenCodeAgentName,
} from "../lib/managed-agents.js";
import {
  describeWriteResult,
  installManagedAgentPrompts,
  readOpenCodeAgentModel,
  readManagedAgentModels,
  readVvocConfig,
  resolvePaths,
  writeGuardianConfig,
  writeManagedAgentModel,
  writeMemoryConfig,
  writeOpenCodeAgentModel,
} from "../lib/opencode.js";
import { createGuardianConfig, createMemoryConfig } from "../lib/vvoc-config.js";

const SPECIAL_AGENT_NAMES = ["guardian", "memory-reviewer"] as const;
type SpecialAgentName = (typeof SPECIAL_AGENT_NAMES)[number];

const CONFIGURABLE_OPENCODE_SUBAGENTS = ["general", "explore"] as const;
type ConfigurableOpenCodeSubagentName = (typeof CONFIGURABLE_OPENCODE_SUBAGENTS)[number];

type AgentName = SpecialAgentName | ConfigurableOpenCodeSubagentName | ManagedOpenCodeAgentName;

const AGENT_NAME_CHOICES = [
  ...SPECIAL_AGENT_NAMES,
  ...CONFIGURABLE_OPENCODE_SUBAGENTS,
  ...MANAGED_OPENCODE_AGENTS.map((definition) => definition.name),
].join(", ");

const agentArg = {
  type: "positional" as const,
  required: true,
  description: `Agent ID (${AGENT_NAME_CHOICES}).`,
};

const modelArg = {
  type: "positional" as const,
  required: true,
  description:
    "Model in provider/model-id format. Guardian and memory-reviewer also accept provider/model-id[:variant].",
};

const agentSet = defineCommand({
  meta: {
    name: "set",
    description: "Set an agent model override.",
  },
  args: {
    agent: agentArg,
    model: modelArg,
  },
  async run({ args }) {
    const agentName = parseAgentName(args.agent, "set");
    const paths = await resolveCommandPaths();

    if (agentName === "guardian") {
      await setGuardianModelOverride(paths, args.model);
      return;
    }

    if (agentName === "memory-reviewer") {
      await setMemoryReviewerModelOverride(paths, args.model);
      return;
    }

    const model = parseOpenCodeModelArg(args.model, "set");

    if (isConfigurableOpenCodeSubagentName(agentName)) {
      const result = await writeOpenCodeAgentModel(paths, agentName, {
        model,
        ensureEntry: true,
      });
      console.log(describeWriteResult(result));
      return;
    }

    await installManagedAgentPrompts(paths, { force: false });
    const result = await writeManagedAgentModel(paths, agentName, {
      model,
      ensureEntry: true,
    });
    console.log(describeWriteResult(result));
  },
});

const agentUnset = defineCommand({
  meta: {
    name: "unset",
    description: "Remove an agent model override.",
  },
  args: {
    agent: agentArg,
  },
  async run({ args }) {
    const agentName = parseAgentName(args.agent, "unset");
    const paths = await resolveCommandPaths();

    if (agentName === "guardian") {
      await unsetGuardianModelOverride(paths);
      return;
    }

    if (agentName === "memory-reviewer") {
      await unsetMemoryReviewerModelOverride(paths);
      return;
    }

    if (isConfigurableOpenCodeSubagentName(agentName)) {
      const result = await writeOpenCodeAgentModel(paths, agentName, {
        ensureEntry: false,
      });
      console.log(describeWriteResult(result));
      return;
    }

    const result = await writeManagedAgentModel(paths, agentName, {
      ensureEntry: false,
    });
    console.log(describeWriteResult(result));
  },
});

const agentList = defineCommand({
  meta: {
    name: "list",
    description: "List configured agent models.",
  },
  async run() {
    const paths = await resolveCommandPaths();

    const vvocConfig = await readVvocConfig(paths);
    const guardianConfig = vvocConfig?.guardian;
    const memoryConfig = vvocConfig?.memory;
    const managedModels = await readManagedAgentModels(paths);

    console.log("Agent models:");
    console.log(`  guardian: ${formatAgentModel(guardianConfig?.model, guardianConfig?.variant)}`);
    console.log(
      `  memory-reviewer: ${formatAgentModel(memoryConfig?.reviewerModel, memoryConfig?.reviewerVariant)}`,
    );

    for (const agentName of CONFIGURABLE_OPENCODE_SUBAGENTS) {
      const model = await readOpenCodeAgentModel(paths, agentName);
      console.log(`  ${agentName}: ${formatAgentModel(model)}`);
    }

    for (const definition of MANAGED_OPENCODE_AGENTS) {
      console.log(`  ${definition.name}: ${formatAgentModel(managedModels[definition.name])}`);
    }
  },
});

export default defineCommand({
  meta: {
    name: "agent",
    description: "Manage agent model overrides.",
  },
  subCommands: {
    set: agentSet,
    unset: agentUnset,
    list: agentList,
  },
});

async function setGuardianModelOverride(
  paths: Awaited<ReturnType<typeof resolveCommandPaths>>,
  value: unknown,
) {
  const { model, variant } = parseGuardianStyleModelArg(value, "set");
  const result = await writeGuardianConfig(paths, { model, variant }, { merge: true });
  console.log(describeWriteResult(result));
}

async function unsetGuardianModelOverride(paths: Awaited<ReturnType<typeof resolveCommandPaths>>) {
  const currentGuardian = (await readVvocConfig(paths))?.guardian ?? createGuardianConfig();
  const { model: _model, variant: _variant, ...rest } = currentGuardian;
  const result = await writeGuardianConfig(paths, rest);
  console.log(describeWriteResult(result));
}

async function setMemoryReviewerModelOverride(
  paths: Awaited<ReturnType<typeof resolveCommandPaths>>,
  value: unknown,
) {
  const { model, variant } = parseGuardianStyleModelArg(value, "set");
  const result = await writeMemoryConfig(
    paths,
    { reviewerModel: model, reviewerVariant: variant },
    { merge: true },
  );
  console.log(describeWriteResult(result));
}

async function unsetMemoryReviewerModelOverride(
  paths: Awaited<ReturnType<typeof resolveCommandPaths>>,
) {
  const currentMemory = (await readVvocConfig(paths))?.memory ?? createMemoryConfig();
  const {
    reviewerModel: _reviewerModel,
    reviewerVariant: _reviewerVariant,
    ...rest
  } = currentMemory;
  const result = await writeMemoryConfig(paths, rest);
  console.log(describeWriteResult(result));
}

async function resolveCommandPaths() {
  return resolvePaths();
}

function formatAgentModel(model?: string, variant?: string): string {
  if (!model) return "default";
  return variant ? `${model}:${variant}` : model;
}

function parseAgentName(value: unknown, operation: string): AgentName {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`agent argument required for ${operation}`);
  }

  const trimmed = value.trim();

  if (trimmed === "guardian" || trimmed === "memory-reviewer") {
    return trimmed;
  }

  if (isConfigurableOpenCodeSubagentName(trimmed) || isManagedOpenCodeAgentName(trimmed)) {
    return trimmed;
  }

  throw new Error(`unsupported agent: ${trimmed}. Expected one of: ${AGENT_NAME_CHOICES}`);
}

function isConfigurableOpenCodeSubagentName(
  value: string,
): value is ConfigurableOpenCodeSubagentName {
  return CONFIGURABLE_OPENCODE_SUBAGENTS.includes(value as ConfigurableOpenCodeSubagentName);
}

function parseGuardianStyleModelArg(
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

function parseOpenCodeModelArg(value: unknown, operation: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`model argument required for ${operation}`);
  }

  const trimmed = value.trim();
  if (!trimmed.includes("/")) {
    throw new Error(`model must be in provider/model-id format, got: ${trimmed}`);
  }

  return trimmed;
}
