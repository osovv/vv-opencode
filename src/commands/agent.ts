// FILE: src/commands/agent.ts
// VERSION: 0.7.0
// START_MODULE_CONTRACT
//   PURPOSE: Manage model overrides for vvoc-owned and selected built-in OpenCode agents.
//   SCOPE: Guardian and memory-reviewer section writes within vvoc.json plus built-in and managed OpenCode agent model set/unset/list operations via the vvoc agent command tree.
//   DEPENDS: [citty, src/lib/agent-models.ts, src/lib/managed-agents.ts, src/lib/opencode.ts, src/lib/vvoc-config.ts]
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
//   LAST_CHANGE: [v0.7.0 - Moved agent ID and model validation into shared helpers for reuse by presets and vvoc config validation.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  AGENT_NAME_CHOICES,
  CONFIGURABLE_OPENCODE_SUBAGENTS,
  isConfigurableOpenCodeSubagentName,
  parseAgentName,
  parseGuardianStyleModelArg,
  parseOpenCodeModelArg,
  formatAgentModel,
} from "../lib/agent-models.js";
import { MANAGED_OPENCODE_AGENTS } from "../lib/managed-agents.js";
import {
  describeWriteResult,
  installManagedAgentPrompts,
  readOpenCodeAgentModel,
  readManagedAgentModels,
  readVvocConfig,
  resolvePaths,
  type Scope,
  writeGuardianConfig,
  writeManagedAgentModel,
  writeMemoryConfig,
  writeOpenCodeAgentModel,
} from "../lib/opencode.js";
import { createGuardianConfig, createMemoryConfig } from "../lib/vvoc-config.js";

const scopeArg = {
  type: "enum" as const,
  options: ["global", "project"],
  default: "global",
  description: "Write global or project config.",
};

const configDirArg = {
  type: "string" as const,
  description: "Override the global config home.",
};

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
    scope: scopeArg,
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const agentName = parseAgentName(args.agent, "set");
    const paths = await resolveCommandPaths(args);

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
    scope: scopeArg,
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const agentName = parseAgentName(args.agent, "unset");
    const paths = await resolveCommandPaths(args);

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
  args: {
    scope: {
      ...scopeArg,
      description: "Show global or project config.",
    },
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const scope = resolveScope(args.scope);
    const paths = await resolveCommandPaths(args);

    const vvocConfig = await readVvocConfig(paths);
    const guardianConfig = vvocConfig?.guardian;
    const memoryConfig = vvocConfig?.memory;
    const managedModels = await readManagedAgentModels(paths);

    console.log(`Agent models (${scope}):`);
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

function resolveScope(value: unknown): Scope {
  return value === "project" ? "project" : "global";
}

async function resolveCommandPaths(args: Record<string, unknown>) {
  const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
  return resolvePaths({
    scope: resolveScope(args.scope),
    cwd: process.cwd(),
    configDir,
  });
}
