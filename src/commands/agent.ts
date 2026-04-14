// FILE: src/commands/agent.ts
// VERSION: 0.9.0
// START_MODULE_CONTRACT
//   PURPOSE: Manage model overrides for vvoc-owned agents plus selected OpenCode model targets.
//   SCOPE: Guardian and memory-reviewer section writes within vvoc.json plus built-in, managed, and top-level OpenCode model plus variant set/unset/list operations via the vvoc agent command tree.
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
//   LAST_CHANGE: [v0.9.0 - Added build/plan targets and variant-aware OpenCode agent overrides while keeping top-level default model fields plain.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  CONFIGURABLE_OPENCODE_AGENTS,
  isConfigurableOpenCodeAgentName,
  isOpenCodeDefaultModelTargetName,
  MODEL_TARGET_NAME_CHOICES,
  parseModelTargetName,
  parseGuardianStyleModelArg,
  parseOpenCodeModelArg,
  parseOpenCodeAgentModelArg,
  formatAgentModel,
} from "../lib/agent-models.js";
import { MANAGED_OPENCODE_AGENTS } from "../lib/managed-agents.js";
import {
  describeWriteResult,
  installManagedAgentPrompts,
  readManagedAgentOverrides,
  readOpenCodeAgentOverride,
  readOpenCodeDefaultModel,
  readVvocConfig,
  resolvePaths,
  type Scope,
  type OpenCodeDefaultModelKey,
  writeGuardianConfig,
  writeOpenCodeDefaultModel,
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
  description: `Model target ID (${MODEL_TARGET_NAME_CHOICES}).`,
};

const modelArg = {
  type: "positional" as const,
  required: true,
  description:
    "Model in provider/model-id format. Guardian, memory-reviewer, build, plan, general, explore, and managed OpenCode agents also accept provider/model-id[:variant].",
};

const agentSet = defineCommand({
  meta: {
    name: "set",
    description: "Set a model target override.",
  },
  args: {
    agent: agentArg,
    model: modelArg,
    scope: scopeArg,
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const agentName = parseModelTargetName(args.agent, "set");
    const paths = await resolveCommandPaths(args);

    if (agentName === "guardian") {
      await setGuardianModelOverride(paths, args.model);
      return;
    }

    if (agentName === "memory-reviewer") {
      await setMemoryReviewerModelOverride(paths, args.model);
      return;
    }

    if (isOpenCodeDefaultModelTargetName(agentName)) {
      const model = parseOpenCodeModelArg(args.model, "set");
      const result = await writeOpenCodeDefaultModel(paths, resolveDefaultModelKey(agentName), {
        model,
        ensureEntry: true,
      });
      console.log(describeWriteResult(result));
      return;
    }

    if (isConfigurableOpenCodeAgentName(agentName)) {
      const { model, variant } = parseOpenCodeAgentModelArg(args.model, "set");
      const result = await writeOpenCodeAgentModel(paths, agentName, {
        model,
        variant,
        ensureEntry: true,
      });
      console.log(describeWriteResult(result));
      return;
    }

    await installManagedAgentPrompts(paths, { force: false });
    const { model, variant } = parseOpenCodeAgentModelArg(args.model, "set");
    const result = await writeManagedAgentModel(paths, agentName, {
      model,
      variant,
      ensureEntry: true,
    });
    console.log(describeWriteResult(result));
  },
});

const agentUnset = defineCommand({
  meta: {
    name: "unset",
    description: "Remove a model target override.",
  },
  args: {
    agent: agentArg,
    scope: scopeArg,
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const agentName = parseModelTargetName(args.agent, "unset");
    const paths = await resolveCommandPaths(args);

    if (agentName === "guardian") {
      await unsetGuardianModelOverride(paths);
      return;
    }

    if (agentName === "memory-reviewer") {
      await unsetMemoryReviewerModelOverride(paths);
      return;
    }

    if (isOpenCodeDefaultModelTargetName(agentName)) {
      const result = await writeOpenCodeDefaultModel(paths, resolveDefaultModelKey(agentName), {
        ensureEntry: false,
      });
      console.log(describeWriteResult(result));
      return;
    }

    if (isConfigurableOpenCodeAgentName(agentName)) {
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
    description: "List configured model targets.",
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
    const managedModels = await readManagedAgentOverrides(paths);

    console.log(`Model targets (${scope}):`);
    console.log(`  default: ${formatAgentModel(await readOpenCodeDefaultModel(paths, "model"))}`);
    console.log(
      `  small-model: ${formatAgentModel(await readOpenCodeDefaultModel(paths, "small_model"))}`,
    );
    console.log(`  guardian: ${formatAgentModel(guardianConfig?.model, guardianConfig?.variant)}`);
    console.log(
      `  memory-reviewer: ${formatAgentModel(memoryConfig?.reviewerModel, memoryConfig?.reviewerVariant)}`,
    );

    for (const agentName of CONFIGURABLE_OPENCODE_AGENTS) {
      const { model, variant } = await readOpenCodeAgentOverride(paths, agentName);
      console.log(`  ${agentName}: ${formatAgentModel(model, variant)}`);
    }

    for (const definition of MANAGED_OPENCODE_AGENTS) {
      console.log(
        `  ${definition.name}: ${formatAgentModel(
          managedModels[definition.name].model,
          managedModels[definition.name].variant,
        )}`,
      );
    }
  },
});

export default defineCommand({
  meta: {
    name: "agent",
    description: "Manage model target overrides.",
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

function resolveDefaultModelKey(targetName: "default" | "small-model"): OpenCodeDefaultModelKey {
  return targetName === "default" ? "model" : "small_model";
}

async function resolveCommandPaths(args: Record<string, unknown>) {
  const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
  return resolvePaths({
    scope: resolveScope(args.scope),
    cwd: process.cwd(),
    configDir,
  });
}
