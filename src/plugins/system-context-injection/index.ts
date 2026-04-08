// FILE: src/plugins/system-context-injection/index.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Inject reusable vvoc system context into primary chat sessions without polluting known subagent prompts.
//   SCOPE: Main-session system instruction definitions, known subagent filtering, config-aware custom subagent tracking, and chat.message system prompt injection.
//   DEPENDS: [@opencode-ai/plugin, src/lib/managed-agents.ts]
//   LINKS: [M-PLUGIN-SYSTEM-CONTEXT-INJECTION, M-CLI-MANAGED-AGENTS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SystemContextInjectionPlugin - Injects reusable system guidance into primary sessions while skipping known subagents.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added a reusable main-session system context injector with default proactive explore guidance.]
// END_CHANGE_SUMMARY

import { type Config, type Plugin } from "@opencode-ai/plugin";
import { MANAGED_SUBAGENT_NAMES } from "../../lib/managed-agents.js";

const BUILT_IN_SUBAGENTS = ["general", "explore"] as const;
const PLUGIN_MANAGED_SUBAGENTS = ["guardian", "memory-reviewer"] as const;
const INTERNAL_PRIMARY_AGENTS = ["compaction", "title", "summary"] as const;

const MAIN_SESSION_SYSTEM_CONTEXTS = [
  [
    "<proactive_context_gathering>",
    "Before answering questions about the codebase or making changes, proactively use the explore subagent to gather the context you need whenever the task depends on unfamiliar code, unclear scope, or multiple candidate implementation areas.",
    "Do not guess about code you have not inspected.",
    "If the task is already localized and the required context is already in view, work directly instead of delegating.",
    "</proactive_context_gathering>",
  ].join("\n"),
] as const;

type AgentConfigShape = {
  mode?: unknown;
};

// START_BLOCK_AGENT_FILTERS
function createKnownSubagentSet(): Set<string> {
  return new Set([...BUILT_IN_SUBAGENTS, ...PLUGIN_MANAGED_SUBAGENTS, ...MANAGED_SUBAGENT_NAMES]);
}

function syncConfiguredSubagents(config: Config, knownSubagents: Set<string>): void {
  for (const [name, definition] of Object.entries(config.agent ?? {})) {
    if ((definition as AgentConfigShape | undefined)?.mode === "subagent") {
      knownSubagents.add(name);
    }
  }
}

function shouldInjectForAgent(agentName: string | undefined, knownSubagents: Set<string>): boolean {
  if (!agentName) {
    return false;
  }
  if (knownSubagents.has(agentName)) {
    return false;
  }
  if (INTERNAL_PRIMARY_AGENTS.includes(agentName as (typeof INTERNAL_PRIMARY_AGENTS)[number])) {
    return false;
  }
  return true;
}
// END_BLOCK_AGENT_FILTERS

// START_BLOCK_SYSTEM_CONTEXT_FORMATTING
function hasInjectedContext(existingSystem: string | undefined, context: string): boolean {
  return typeof existingSystem === "string" && existingSystem.includes(context);
}

function appendSystemContexts(
  existingSystem: string | undefined,
  contexts: readonly string[],
): string {
  const parts: string[] = [];

  if (typeof existingSystem === "string" && existingSystem.trim()) {
    parts.push(existingSystem.trim());
  }

  for (const context of contexts) {
    if (!hasInjectedContext(existingSystem, context)) {
      parts.push(context);
    }
  }

  return parts.join("\n\n");
}
// END_BLOCK_SYSTEM_CONTEXT_FORMATTING

// START_BLOCK_PLUGIN_ENTRY
export const SystemContextInjectionPlugin: Plugin = async () => {
  const knownSubagents = createKnownSubagentSet();

  return {
    config: async (config) => {
      syncConfiguredSubagents(config, knownSubagents);
    },
    "chat.message": async (_input, output) => {
      if (!shouldInjectForAgent(output.message.agent, knownSubagents)) {
        return;
      }

      output.message.system = appendSystemContexts(
        output.message.system,
        MAIN_SESSION_SYSTEM_CONTEXTS,
      );
    },
  };
};
// END_BLOCK_PLUGIN_ENTRY
