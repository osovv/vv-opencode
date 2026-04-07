// FILE: src/commands/agent.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Manage model overrides for vvoc-owned OpenCode agents.
//   SCOPE: Guardian and memory-reviewer config writes plus managed OpenCode subagent model setting, unsetting, and listing via the vvoc agent command tree.
//   DEPENDS: [citty, src/lib/managed-agents.ts, src/lib/opencode.ts, src/plugins/memory-store.ts]
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
//   LAST_CHANGE: [v0.4.0 - Added vvoc-managed implementer/spec-reviewer/code-reviewer/investitagor subagent model management.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { MANAGED_SUBAGENTS, type ManagedSubagentName } from "../lib/managed-agents.js";
import {
  describeWriteResult,
  installManagedAgentPrompts,
  parseGuardianConfigText,
  readManagedSubagentModels,
  renderGuardianConfig,
  resolvePaths,
  type Scope,
  writeManagedSubagentModel,
} from "../lib/opencode.js";
import {
  parseMemoryConfigText,
  renderMemoryConfig,
  type MemoryConfigOverrides,
} from "../plugins/memory-store.js";

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

const modelArg = {
  type: "positional" as const,
  required: true,
  description: "Model in provider/model-id format.",
};

const guardianSet = defineCommand({
  meta: {
    name: "set",
    description: "Set the Guardian agent model override.",
  },
  args: {
    model: {
      ...modelArg,
      description: "Model in provider/model-id[:variant] format.",
    },
    scope: scopeArg,
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const { model, variant } = parseGuardianStyleModelArg(args.model, "set");
    const paths = await resolveCommandPaths(args);

    const currentText = await Bun.file(paths.guardianConfigPath)
      .text()
      .catch(() => "");
    const current = currentText
      ? parseGuardianConfigText(currentText, paths.guardianConfigPath)
      : {};
    const merged = { ...current, model, variant };

    const nextText = renderGuardianConfig(merged);
    if (currentText.trim() === nextText.trim()) {
      console.log(describeWriteResult({ action: "kept", path: paths.guardianConfigPath }));
      return;
    }

    await Bun.write(paths.guardianConfigPath, nextText);
    console.log(
      describeWriteResult({
        action: currentText ? "updated" : "created",
        path: paths.guardianConfigPath,
      }),
    );
  },
});

const guardianUnset = defineCommand({
  meta: {
    name: "unset",
    description: "Remove the Guardian agent model override.",
  },
  args: {
    scope: scopeArg,
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const paths = await resolveCommandPaths(args);

    const currentText = await Bun.file(paths.guardianConfigPath)
      .text()
      .catch(() => "");
    if (!currentText) {
      console.log(describeWriteResult({ action: "kept", path: paths.guardianConfigPath }));
      return;
    }

    const current = parseGuardianConfigText(currentText, paths.guardianConfigPath);
    const { model: _model, variant: _variant, ...rest } = current;
    const nextText = renderGuardianConfig(rest);

    if (currentText.trim() === nextText.trim()) {
      console.log(describeWriteResult({ action: "kept", path: paths.guardianConfigPath }));
      return;
    }

    await Bun.write(paths.guardianConfigPath, nextText);
    console.log(describeWriteResult({ action: "updated", path: paths.guardianConfigPath }));
  },
});

const guardianCmd = defineCommand({
  meta: {
    name: "guardian",
    description: "Manage the Guardian agent.",
  },
  subCommands: {
    set: guardianSet,
    unset: guardianUnset,
  },
});

const memoryReviewerSet = defineCommand({
  meta: {
    name: "set",
    description: "Set the memory-reviewer agent model override.",
  },
  args: {
    model: {
      ...modelArg,
      description: "Model in provider/model-id[:variant] format.",
    },
    scope: scopeArg,
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const { model, variant } = parseGuardianStyleModelArg(args.model, "set");
    const paths = await resolveCommandPaths(args);

    const currentText = await Bun.file(paths.memoryConfigPath)
      .text()
      .catch(() => "");
    const current = currentText ? parseMemoryConfigText(currentText, paths.memoryConfigPath) : {};
    const merged: MemoryConfigOverrides = {
      enabled: current.enabled ?? true,
      defaultSearchLimit: current.defaultSearchLimit,
      reviewerModel: model,
      reviewerVariant: variant,
    };

    const nextText = renderMemoryConfig(merged);
    if (currentText.trim() === nextText.trim()) {
      console.log(describeWriteResult({ action: "kept", path: paths.memoryConfigPath }));
      return;
    }

    await Bun.write(paths.memoryConfigPath, nextText);
    console.log(
      describeWriteResult({
        action: currentText ? "updated" : "created",
        path: paths.memoryConfigPath,
      }),
    );
  },
});

const memoryReviewerUnset = defineCommand({
  meta: {
    name: "unset",
    description: "Remove the memory-reviewer agent model override.",
  },
  args: {
    scope: scopeArg,
    "config-dir": configDirArg,
  },
  async run({ args }) {
    const paths = await resolveCommandPaths(args);

    const currentText = await Bun.file(paths.memoryConfigPath)
      .text()
      .catch(() => "");
    if (!currentText) {
      console.log(describeWriteResult({ action: "kept", path: paths.memoryConfigPath }));
      return;
    }

    const current = parseMemoryConfigText(currentText, paths.memoryConfigPath);
    const nextText = renderMemoryConfig({
      enabled: current.enabled ?? true,
      defaultSearchLimit: current.defaultSearchLimit,
    });

    if (currentText.trim() === nextText.trim()) {
      console.log(describeWriteResult({ action: "kept", path: paths.memoryConfigPath }));
      return;
    }

    await Bun.write(paths.memoryConfigPath, nextText);
    console.log(describeWriteResult({ action: "updated", path: paths.memoryConfigPath }));
  },
});

const memoryReviewerCmd = defineCommand({
  meta: {
    name: "memory-reviewer",
    description: "Manage the memory-reviewer agent.",
  },
  subCommands: {
    set: memoryReviewerSet,
    unset: memoryReviewerUnset,
  },
});

const managedSubagentCommands = Object.fromEntries(
  MANAGED_SUBAGENTS.map((definition) => [
    definition.name,
    defineCommand({
      meta: {
        name: definition.name,
        description: `Manage the ${definition.name} agent.`,
      },
      subCommands: {
        set: createManagedSubagentSetCommand(definition.name),
        unset: createManagedSubagentUnsetCommand(definition.name),
      },
    }),
  ]),
);

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

    const guardianText = await Bun.file(paths.guardianConfigPath)
      .text()
      .catch(() => "");
    const memoryText = await Bun.file(paths.memoryConfigPath)
      .text()
      .catch(() => "");

    const guardianConfig = guardianText
      ? parseGuardianConfigText(guardianText, paths.guardianConfigPath)
      : {};
    const memoryConfig = memoryText
      ? parseMemoryConfigText(memoryText, paths.memoryConfigPath)
      : {};
    const managedModels = await readManagedSubagentModels(paths);

    console.log(`Agent models (${scope}):`);
    console.log(`  guardian: ${formatAgentModel(guardianConfig.model, guardianConfig.variant)}`);
    console.log(
      `  memory-reviewer: ${formatAgentModel(memoryConfig.reviewerModel, memoryConfig.reviewerVariant)}`,
    );

    for (const definition of MANAGED_SUBAGENTS) {
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
    guardian: guardianCmd,
    "memory-reviewer": memoryReviewerCmd,
    ...managedSubagentCommands,
    list: agentList,
  },
});

function createManagedSubagentSetCommand(agentName: ManagedSubagentName) {
  return defineCommand({
    meta: {
      name: "set",
      description: `Set the ${agentName} agent model override.`,
    },
    args: {
      model: modelArg,
      scope: scopeArg,
      "config-dir": configDirArg,
    },
    async run({ args }) {
      const model = parseOpenCodeModelArg(args.model, "set");
      const paths = await resolveCommandPaths(args);

      await installManagedAgentPrompts(paths, { force: false });
      const result = await writeManagedSubagentModel(paths, agentName, {
        model,
        ensureEntry: true,
      });
      console.log(describeWriteResult(result));
    },
  });
}

function createManagedSubagentUnsetCommand(agentName: ManagedSubagentName) {
  return defineCommand({
    meta: {
      name: "unset",
      description: `Remove the ${agentName} agent model override.`,
    },
    args: {
      scope: scopeArg,
      "config-dir": configDirArg,
    },
    async run({ args }) {
      const paths = await resolveCommandPaths(args);
      const result = await writeManagedSubagentModel(paths, agentName, {
        ensureEntry: false,
      });
      console.log(describeWriteResult(result));
    },
  });
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

function formatAgentModel(model?: string, variant?: string): string {
  if (!model) return "default";
  return variant ? `${model}:${variant}` : model;
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
