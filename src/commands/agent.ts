// FILE: src/commands/agent.ts
// VERSION: 0.3.4
// START_MODULE_CONTRACT
//   PURPOSE: Manage agent model overrides for guardian and memory-reviewer agents.
//   SCOPE: Agent model setting, unsetting, and listing via vvoc agent command tree.
//   DEPENDS: [citty, src/lib/opencode.ts, src/plugins/memory-store.ts]
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
//   LAST_CHANGE: [v0.3.4 - Added granular agent model configuration via vvoc agent command.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  describeWriteResult,
  parseGuardianConfigText,
  renderGuardianConfig,
  resolvePaths,
  type Scope,
} from "../lib/opencode.js";
import {
  parseMemoryConfigText,
  renderMemoryConfig,
  type MemoryConfigOverrides,
} from "../plugins/memory-store.js";

const guardianSet = defineCommand({
  meta: {
    name: "set",
    description: "Set the Guardian agent model override.",
  },
  args: {
    model: {
      type: "positional",
      required: true,
      description: "Model in provider/model-id[:variant] format.",
    },
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Write global or project config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home.",
    },
  },
  async run({ args }) {
    const { model, variant } = parseModelArg(args.model, "set");

    const scope = args.scope === "project" ? "project" : "global";
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const paths = await resolvePaths({ scope: scope as Scope, cwd: process.cwd(), configDir });

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
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Write global or project config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home.",
    },
  },
  async run({ args }) {
    const scope = args.scope === "project" ? "project" : "global";
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const paths = await resolvePaths({ scope: scope as Scope, cwd: process.cwd(), configDir });

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
      type: "positional",
      required: true,
      description: "Model in provider/model-id[:variant] format.",
    },
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Write global or project config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home.",
    },
  },
  async run({ args }) {
    const { model, variant } = parseModelArg(args.model, "set");

    const overrides: MemoryConfigOverrides = { reviewerModel: model };
    if (variant) {
      overrides.reviewerVariant = variant;
    }

    const scope = args.scope === "project" ? "project" : "global";
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const paths = await resolvePaths({ scope: scope as Scope, cwd: process.cwd(), configDir });

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
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Write global or project config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home.",
    },
  },
  async run({ args }) {
    const scope = args.scope === "project" ? "project" : "global";
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const paths = await resolvePaths({ scope: scope as Scope, cwd: process.cwd(), configDir });

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

const agentList = defineCommand({
  meta: {
    name: "list",
    description: "List configured agent models.",
  },
  args: {
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Show global or project config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home.",
    },
  },
  async run({ args }) {
    const scope = args.scope === "project" ? "project" : "global";
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const paths = await resolvePaths({ scope: scope as Scope, cwd: process.cwd(), configDir });

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

    console.log(`Agent models (${scope}):`);
    console.log(`  guardian: ${formatAgentModel(guardianConfig.model, guardianConfig.variant)}`);
    console.log(
      `  memory-reviewer: ${formatAgentModel(memoryConfig.reviewerModel, memoryConfig.reviewerVariant)}`,
    );
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
    list: agentList,
  },
});

function formatAgentModel(model?: string, variant?: string): string {
  if (!model) return "default";
  return variant ? `${model}:${variant}` : model;
}

function parseModelArg(value: unknown, operation: string): { model: string; variant?: string } {
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
