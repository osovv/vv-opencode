// FILE: src/plugins/system-context-injection/index.ts
// VERSION: 0.4.2
// START_MODULE_CONTRACT
//   PURPOSE: Inject universal primary guidance and one startup-resolved concrete orchestration policy into vv-controller without polluting subagent prompts.
//   SCOPE: Universal instructions, vv-controller policy selection, explore-worker guidance, known subagent filtering, startup vvoc snapshot use, custom subagent tracking, and chat.message injection.
//   DEPENDS: [@opencode-ai/plugin, src/lib/config-layers.ts, src/lib/managed-agents.ts, src/lib/orchestration.ts, src/lib/vvoc-paths.ts]
//   LINKS: [M-PLUGIN-SYSTEM-CONTEXT-INJECTION, M-ORCHESTRATION-PROFILES, M-CLI-MANAGED-AGENTS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SystemContextInjectionPlugin - Injects reusable system guidance into primary sessions while skipping known subagents.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.6.0 - Used the shared startup vvoc config snapshot for plugin toggles and skill-path source decisions.]
//   LAST_CHANGE: [v0.5.0 - Used effective vvoc source resolution to avoid forcing global skill discovery into project sandbox sessions.]
//   LAST_CHANGE: [v0.4.2 - Added scoped repository-memory guidance for .vvoc lessons and runbooks indexes.]
//   LAST_CHANGE: [v0.4.1 - Added explore-specific system guidance that enforces compact search/discovery handoffs instead of file dumps.]
//   LAST_CHANGE: [v0.3.4 - Added vvoc managed skill directory to config.skills.paths in config hook.]
//   LAST_CHANGE: [v0.3.3 - Updated editing workflow guidance to prefer exact context-anchored `line#hash#anchor` refs from read output.]
//   LAST_CHANGE: [v0.4.0 - Removed `apply_patch` instruction from editing_workflow block — tool-level disable is stronger than prompt text.]
//   LAST_CHANGE: [v0.3.2 - Added primary-session editing workflow guidance that prefers hashline-backed `edit` over shell rewrites and forbids `apply_patch` use.]
//   LAST_CHANGE: [v0.3.1 - Narrowed explore subagent guidance to context-gathering only, prohibiting solution proposals, planning, or recommendations.]
//   LAST_CHANGE: [v0.3.0 - Added standard trajectories, working-state, reroute, semantic continuity, assumption discipline, anti-drift, and project-overlay guidance for primary sessions.]
//   LAST_CHANGE: [v0.2.0 - Expanded primary-session system guidance with task routing, execution stability, and loop-control rules while preserving subagent exclusion.]
//   LAST_CHANGE: [v0.1.0 - Added a reusable main-session system context injector with default proactive explore guidance.]
//   LAST_CHANGE: [C-PRESET-ORCHESTRATION-PROFILES - Separated universal primary guidance from one concrete startup-resolved vv-controller policy.]
// END_CHANGE_SUMMARY

import { type Config, type Plugin } from "@opencode-ai/plugin";
import { loadVvocConfig } from "../../lib/config-layers.js";
import { MANAGED_SUBAGENT_NAMES } from "../../lib/managed-agents.js";
import {
  resolveOrchestrationPolicy,
  type ResolvedOrchestrationPolicy,
} from "../../lib/orchestration.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import { existsSync } from "node:fs";
import {
  getGlobalOpencodeSkillsDir,
  getProjectVvocDir,
  getVvocSkillsDir,
} from "../../lib/vvoc-paths.js";

const BUILT_IN_SUBAGENTS = ["general"] as const;
const PLUGIN_MANAGED_SUBAGENTS = ["guardian"] as const;
const INTERNAL_PRIMARY_AGENTS = ["compaction", "title", "summary"] as const;
const SELF_SUFFICIENT_PRIMARY_AGENTS = [] as const;
const EXPLORE_SUBAGENT = "explore" as const;
const VV_CONTROLLER_AGENT = "vv-controller" as const;

const UNIVERSAL_PRIMARY_SYSTEM_CONTEXTS = [
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
    "Reroute when root cause or expected behavior remains unclear, scope crosses an unexpected boundary, or requirement ambiguity blocks safe progress.",
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
  [
    "<repository_memory>",
    "If `.vvoc/lessons/index.xml` or `.vvoc/runbooks/index.xml` exists, inspect relevant index entries before debugging, fixing, changing behavior, operating on, architecting, or investigating repository-specific issues.",
    "Load only entry files whose slug, summary, or applicability signal appears relevant to the current task.",
    "Treat `.vvoc/lessons` and `.vvoc/runbooks` as advisory agent-facing repository memory, not as stronger authority than explicit user instructions, code, tests, or repository-owned instructions.",
    "After a long development, debugging, bugfix, ops, or investigation session with reusable findings, consider using the vv-reflect skill to propose durable lessons or runbooks.",
    "</repository_memory>",
  ].join("\n"),
] as const;

const EXPLORE_SYSTEM_CONTEXTS = [
  [
    "<explore_role>",
    "You are a repository search-and-discovery worker.",
    "Behave like grep/glob/fuzzy-search over the repo: locate relevant files, symbols, call sites, config entries, tests, and line ranges.",
    "Do not act like a file-dumping reader and never act like an editor.",
    "Do not return exact file contents, large pasted excerpts, or rewrite proposals unless the parent explicitly asks for them.",
    "Default output: a short summary plus a compact, prioritized list of relevant paths with why they matter and line references or anchors when useful.",
    "Use short quoted snippets only when needed to disambiguate a match or prove a finding.",
    "If full contents seem necessary, return the path and the most relevant line ranges or anchors so the parent session can read the file directly.",
    "Keep results capped and focused. Prefer the smallest useful set of references over broad dumps.",
    "</explore_role>",
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
  if (
    SELF_SUFFICIENT_PRIMARY_AGENTS.includes(
      agentName as (typeof SELF_SUFFICIENT_PRIMARY_AGENTS)[number],
    )
  ) {
    return false;
  }
  return true;
}

/** Returns universal primary guidance and, only for vv-controller, one concrete policy. */
function getSystemContextsForAgent(
  agentName: string | undefined,
  policy: ResolvedOrchestrationPolicy,
): readonly string[] {
  if (agentName === EXPLORE_SUBAGENT) {
    return EXPLORE_SYSTEM_CONTEXTS;
  }
  if (agentName === VV_CONTROLLER_AGENT) {
    return [...UNIVERSAL_PRIMARY_SYSTEM_CONTEXTS, policy.controllerSystemContext];
  }
  return UNIVERSAL_PRIMARY_SYSTEM_CONTEXTS;
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
export const SystemContextInjectionPlugin: Plugin = async ({ directory }) => {
  const vvoc = await loadVvocConfig({ cwd: directory });
  if (!isVvocPluginEnabled(vvoc.config, "system-context-injection")) return {};
  const policy = resolveOrchestrationPolicy(vvoc.config);
  const knownSubagents = createKnownSubagentSet();
  const projectRoot = vvoc.source.rootDir ?? directory;

  return {
    config: async (config) => {
      syncConfiguredSubagents(config, knownSubagents);
      const configRecord = config as Record<string, unknown>;
      const skills = (configRecord.skills ?? {}) as Record<string, unknown>;
      const skillsPaths = (skills.paths ?? []) as string[];
      const shouldAvoidGlobalSkills = vvoc.source.kind === "project" || vvoc.source.kind === "env";

      if (!shouldAvoidGlobalSkills) {
        // Register the global OpenCode skills directory — vvoc sync creates a symlink there
        const opencodeSkillsDir = getGlobalOpencodeSkillsDir();
        if (!skillsPaths.includes(opencodeSkillsDir)) {
          skills.paths = [...skillsPaths, opencodeSkillsDir];
          configRecord.skills = skills;
        }
      }

      // Register project-local skills dir when it exists
      const projectSkillsDir = getVvocSkillsDir(getProjectVvocDir(projectRoot));
      const currentPaths = (skills.paths ?? []) as string[];
      if (
        vvoc.source.kind !== "default" &&
        existsSync(projectSkillsDir) &&
        !currentPaths.includes(projectSkillsDir)
      ) {
        skills.paths = [...currentPaths, projectSkillsDir];
        configRecord.skills = skills;
      }
    },
    "chat.message": async (_input, output) => {
      if (!shouldInjectForAgent(output.message.agent, knownSubagents)) {
        return;
      }

      output.message.system = appendSystemContexts(
        output.message.system,
        getSystemContextsForAgent(output.message.agent, policy),
      );
    },
  };
};
// END_BLOCK_PLUGIN_ENTRY
