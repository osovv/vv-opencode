// FILE: src/commands/agent.ts
// VERSION: 0.4.3
// START_MODULE_CONTRACT
//   PURPOSE: Manage model overrides for vvoc-owned and selected built-in OpenCode agents.
//   SCOPE: Guardian and memory-reviewer config writes plus built-in and managed OpenCode subagent model set/unset/list operations via the vvoc agent command tree.
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
//   LAST_CHANGE: [v0.4.3 - Reworked agent CLI shape to `vvoc agent set|unset <agent-id>` while keeping support for guardian, memory-reviewer, built-in, and managed subagents.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { MANAGED_SUBAGENTS, type ManagedSubagentName } from "../lib/managed-agents.js";
import {
  describeWriteResult,
  installManagedAgentPrompts,
  parseGuardianConfigText,
  readOpenCodeAgentModel,
  readManagedSubagentModels,
  renderGuardianConfig,
  resolvePaths,
  type Scope,
  writeManagedSubagentModel,
  writeOpenCodeAgentModel,
} from "../lib/opencode.js";
import { parseMemoryConfigText, renderMemoryConfig } from "../plugins/memory-store.js";

const SPECIAL_AGENT_NAMES = ["guardian", "memory-reviewer"] as const;
type SpecialAgentName = (typeof SPECIAL_AGENT_NAMES)[number];

const CONFIGURABLE_OPENCODE_SUBAGENTS = ["general", "explore"] as const;
type ConfigurableOpenCodeSubagentName = (typeof CONFIGURABLE_OPENCODE_SUBAGENTS)[number];

type AgentName = SpecialAgentName | ConfigurableOpenCodeSubagentName | ManagedSubagentName;

const AGENT_NAME_CHOICES = [
  ...SPECIAL_AGENT_NAMES,
  ...CONFIGURABLE_OPENCODE_SUBAGENTS,
  ...MANAGED_SUBAGENTS.map((definition) => definition.name),
].join(", ");

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
    const result = await writeManagedSubagentModel(paths, agentName, {
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

    const result = await writeManagedSubagentModel(paths, agentName, {
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

    for (const agentName of CONFIGURABLE_OPENCODE_SUBAGENTS) {
      const model = await readOpenCodeAgentModel(paths, agentName);
      console.log(`  ${agentName}: ${formatAgentModel(model)}`);
    }

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
  const currentText = await Bun.file(paths.guardianConfigPath)
    .text()
    .catch(() => "");
  const current = currentText ? parseGuardianConfigText(currentText, paths.guardianConfigPath) : {};
  const nextText = renderGuardianConfig({ ...current, model, variant });

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
}

async function unsetGuardianModelOverride(paths: Awaited<ReturnType<typeof resolveCommandPaths>>) {
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
}

async function setMemoryReviewerModelOverride(
  paths: Awaited<ReturnType<typeof resolveCommandPaths>>,
  value: unknown,
) {
  const { model, variant } = parseGuardianStyleModelArg(value, "set");
  const currentText = await Bun.file(paths.memoryConfigPath)
    .text()
    .catch(() => "");
  const current = currentText ? parseMemoryConfigText(currentText, paths.memoryConfigPath) : {};
  const nextText = renderMemoryConfig({
    enabled: current.enabled ?? true,
    defaultSearchLimit: current.defaultSearchLimit,
    reviewerModel: model,
    reviewerVariant: variant,
  });

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
}

async function unsetMemoryReviewerModelOverride(
  paths: Awaited<ReturnType<typeof resolveCommandPaths>>,
) {
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

function parseAgentName(value: unknown, operation: string): AgentName {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`agent argument required for ${operation}`);
  }

  const trimmed = value.trim();

  if (trimmed === "guardian" || trimmed === "memory-reviewer") {
    return trimmed;
  }

  if (isConfigurableOpenCodeSubagentName(trimmed) || isManagedSubagentName(trimmed)) {
    return trimmed;
  }

  throw new Error(`unsupported agent: ${trimmed}. Expected one of: ${AGENT_NAME_CHOICES}`);
}

function isConfigurableOpenCodeSubagentName(
  value: string,
): value is ConfigurableOpenCodeSubagentName {
  return CONFIGURABLE_OPENCODE_SUBAGENTS.includes(value as ConfigurableOpenCodeSubagentName);
}

function isManagedSubagentName(value: string): value is ManagedSubagentName {
  return MANAGED_SUBAGENTS.some((definition) => definition.name === value);
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
