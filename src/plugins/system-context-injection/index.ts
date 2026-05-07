// FILE: src/plugins/system-context-injection/index.ts
// VERSION: 0.3.3
// START_MODULE_CONTRACT
//   PURPOSE: Inject reusable vvoc system context into primary chat sessions without polluting known subagent prompts.
//   SCOPE: Main-session system instruction definitions, editing-workflow guidance, known subagent filtering, config-aware custom subagent tracking, and chat.message system prompt injection.
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
//   LAST_CHANGE: [v0.3.3 - Updated editing workflow guidance to prefer exact context-anchored `line#hash#anchor` refs from read output.]
//   LAST_CHANGE: [v0.4.0 - Removed `apply_patch` instruction from editing_workflow block — tool-level disable is stronger than prompt text.]
//   LAST_CHANGE: [v0.3.2 - Added primary-session editing workflow guidance that prefers hashline-backed `edit` over shell rewrites and forbids `apply_patch` use.]
//   LAST_CHANGE: [v0.3.1 - Narrowed explore subagent guidance to context-gathering only, prohibiting solution proposals, planning, or recommendations.]
//   LAST_CHANGE: [v0.3.0 - Added standard trajectories, working-state, reroute, semantic continuity, assumption discipline, anti-drift, and project-overlay guidance for primary sessions.]
//   LAST_CHANGE: [v0.2.0 - Expanded primary-session system guidance with task routing, execution stability, and loop-control rules while preserving subagent exclusion.]
//   LAST_CHANGE: [v0.1.0 - Added a reusable main-session system context injector with default proactive explore guidance.]
// END_CHANGE_SUMMARY

import { type Config, type Plugin } from "@opencode-ai/plugin";
import { MANAGED_SUBAGENT_NAMES } from "../../lib/managed-agents.js";
import { isPluginEnabled } from "../../lib/plugin-toggle-config.js";

const BUILT_IN_SUBAGENTS = ["general", "explore"] as const;
const PLUGIN_MANAGED_SUBAGENTS = ["guardian"] as const;
const INTERNAL_PRIMARY_AGENTS = ["compaction", "title", "summary"] as const;

const MAIN_SESSION_SYSTEM_CONTEXTS = [
  [
    "<proactive_context_gathering>",
    "Before answering questions about the codebase or making changes, gather the context you need whenever the task depends on unfamiliar code, unclear scope, or multiple candidate implementation areas.",
    "When delegation is available, proactively use the explore subagent for this.",
    "Use the explore subagent ONLY for context gathering operations: finding files, reading code, searching for patterns, mapping module relationships, and collecting factual information about the codebase.",
    "Keep explore requests focused on factual context gathering.",
    "Gather evidence before acting on unfamiliar code.",
    "If the task is already localized and the required context is already in view, work directly.",
    "If the current agent cannot delegate, work with the context already in view.",
    "</proactive_context_gathering>",
  ].join("\n"),
  [
    "<semantic_continuity>",
    "Reuse stable domain terms from the user request and the repository.",
    "When the repository already has a canonical name for a concept, keep that name.",
    "If the user's wording conflicts with repository terminology, map it once and continue with the repository's canonical term.",
    "Keep stable domain terms across planning, implementation, review, and reporting.",
    "</semantic_continuity>",
  ].join("\n"),
  [
    "<assumption_discipline>",
    "Do not make silent material assumptions.",
    "A material assumption is one that affects behavior, scope, API shape, schema, UX, data meaning, or verification.",
    "If a material assumption is necessary, state it explicitly.",
    "If a material assumption later becomes false, stop and reroute.",
    "</assumption_discipline>",
  ].join("\n"),
  [
    "<standard_trajectories>",
    "Prefer known trajectories over ad-hoc behavior.",
    "Default trajectories: localized explicit change -> direct_change; bug, regression, or failure -> investigate_first; ambiguous or multi-file change -> change_with_review; explicit review request -> review directly; unclear request -> clarify or proceed with explicit assumptions, then route.",
    "Prefer existing project patterns, existing libraries, and established repository structure over novel approaches.",
    "</standard_trajectories>",
  ].join("\n"),
  [
    "<task_routing>",
    "Before acting on a non-trivial request, classify it as one of: direct_change, investigate_first, or change_with_review.",
    "Use the lightest safe path.",
    "Start subagents only after goal, acceptance criteria, and verification are stable.",
    "If the current agent cannot delegate, reason through the routing mentally.",
    "</task_routing>",
  ].join("\n"),
  [
    "<working_state>",
    "For non-trivial work, stabilize a compact working state before acting: goal, current route, constraints, non-goals when relevant, assumptions, verification target, current unknown, and reroute if.",
    "Keep it compact and revise it when evidence changes.",
    "Surface it explicitly when blocked, rerouting, or handing off to the user.",
    "</working_state>",
  ].join("\n"),
  [
    "<editing_workflow>",
    "When editing files, prefer the `edit` tool over shell-based rewrites when it is available.",
    "Read the file first, then use exact `line#hash#anchor` refs from the latest `read` output when present.",
    "Reserve `bash` for tests, builds, git, and other non-file-edit commands.",
    "</editing_workflow>",
  ].join("\n"),
  [
    "<reroute_on_evidence>",
    "When new evidence invalidates the current route, stop and reroute.",
    "Reroute triggers: direct_change -> investigate_first when root cause, failure path, or expected behavior is still unclear; direct_change -> change_with_review when the scope expands across multiple modules or architectural boundaries; investigate_first -> direct_change when the failure is bounded and the fix path is now clear; any route -> needs_context when requirement ambiguity blocks safe progress.",
    "When rerouting, state the current route, the trigger, the next route, and why the previous route is no longer safe.",
    "</reroute_on_evidence>",
  ].join("\n"),
  [
    "<anti_drift_budget>",
    "When repeated attempts do not converge, stop and summarize.",
    "Drift signals include repeated file reading without a stable path, repeated speculative fixes without stronger evidence, 2 major strategy changes for the same task, 2 review rounds without convergence, or requirement interpretation changing repeatedly during execution.",
    "When drift signals accumulate, report what was learned, what remains unknown, and which route is now safest.",
    "</anti_drift_budget>",
  ].join("\n"),
  [
    "<project_overlays>",
    "If the task context or repository provides project-specific vocabulary, preferred patterns, boundaries, verification commands, architecture notes, or examples, treat them as project-owned overlays.",
    "Prefer those overlays over generic vvoc defaults when they do not conflict with the user's request.",
    "Use only overlays provided in the task context or repository.",
    "</project_overlays>",
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
  if (!(await isPluginEnabled("system-context-injection"))) return {};
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
