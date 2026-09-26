// FILE: src/plugins/system-context-injection/index.ts
// VERSION: 0.6.0
// START_MODULE_CONTRACT
//   PURPOSE: Inject universal primary guidance, including correctness obligations and evidence discipline for behavior changes, and one startup-resolved concrete orchestration policy into vv-controller without polluting subagent prompts.
//   SCOPE: Universal instructions with correctness obligations, material-assumption discipline, settled-conclusion reopen triggers, false-premise handling, and pressure-versus-evidence distinction; vv-controller policy selection; explore-worker guidance; known subagent filtering; startup vvoc snapshot use; custom subagent tracking; and chat.message injection.
//   DEPENDS: [@opencode-ai/plugin, src/lib/config-layers.ts, src/lib/managed-agents.ts, src/lib/orchestration.ts, src/lib/vvoc-paths.ts, src/plugins/v2-runtime/index.ts]
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
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-001 - Added the dual subpath entrypoint so the plugin loads under OpenCode v1 via server() and v2 via setup(). Prior: DIRECT-FIX refine-thinking-discipline - Added settled-evidence reopen triggers, false-premise handling, pressure-versus-evidence distinction, and test-results-as-evidence wording, while preserving material-assumption discipline, repository-answerable question resolution, and honest uncertainty.]
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
    "If a material assumption is necessary, state it explicitly and carry its effect into the result report.",
    "If a material assumption later becomes false, stop and reroute.",
    "Resolve repository-answerable technical questions from the established code, contracts, and tests yourself; only a genuine business-semantics fork needs a user decision.",
    "When a request assumes something that does not exist (a library, file, or behavior), surface the false premise and investigate the actual mechanism; continue only if the original goal stays unambiguous and within the approved scope, and never silently substitute a different goal or add an unnecessary dependency to make the premise true.",
    "Report honest residual uncertainty: an unverified material condition is named as unverified, never presented as a passed check.",
    "</assumption_discipline>",
  ].join("\n"),
  [
    "<execution_source_and_authority>",
    "Execution ownership, requirement source, and authority are distinct: a native spec/plan package, a provided plan, and the current conversation are all valid sources, and none of them by itself implies a different ownership model.",
    "Required reviews are exactly those declared by the selected source, explicitly requested by the user, or explicitly registered by the controller; do not invent a universal final-review pair.",
    "When the user explicitly authorizes autonomous completion, record it as a bounded advance authority with a finite shared reserve. Use it only after ordinary allowances are exhausted, disclose material decisions without turning each into a blocking question, and still respect reserved stops, host permissions, and destructive, publication, or credential operations.",
    "Report completion honestly as controller-accepted when no independent review was assigned, and as independently reviewed only when every registered obligation actually passed for the current result.",
    "</execution_source_and_authority>",
  ].join("\n"),
  [
    "<correctness_obligations>",
    "For behavior changes, run a compact correctness cycle before reporting done: state the target effect, derive the material properties that must be preserved from the request and established contracts, identify the directly affected consumers, challenge at least one material assumption with a diagnostic counterexample, choose verification proportionate to the risk, report the observed result, and name the remaining uncertainty.",
    "Separate write scope (what you may edit), impact scope (behavior that could change), and verification scope (what you actually check). Investigating directly affected consumers to understand impact is required; broadening writes beyond the approved scope is not — request a scope decision instead.",
    "Choose verification at the level where the risk arises. Derive test expectations from the contract and the request, not from the implementation's current output, and ground mocks in the dependency's established contract rather than in whatever makes the change pass.",
    "Report honestly what was inspected, what was reasoned about, and what was executed as a check. The absence of a discovered defect is not proof of correctness: a substantive completion claim needs observed evidence, and an unverified material condition is reported as remaining uncertainty, never presented as a passed check.",
    "Once required checks substantiate the material claims for the current files and inputs, move forward; recheck for changed inputs, uncovered material properties, conflicting evidence, or a mandatory gate, not for reassurance alone.",
    "Interpret test results as evidence against the request and established contracts, not as the authoritative specification: a failing test that contradicts the agreed contract is a discrepancy to surface, not an automatic reason to rewrite code or tests.",
    "Unrelated informational or trivial documentation work needs none of this ceremony.",
    "</correctness_obligations>",
  ].join("\n"),
  [
    "<working_state>",
    "For non-trivial work, stabilize a compact working state before acting: goal, current route, constraints, non-goals when relevant, assumptions, verification target, current unknown, and reroute if.",
    "Check that state against the original request before and while acting; a constraint dropped early wastes the downstream chain.",
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
    "A retry must carry a named diagnosis of the prior failure; a blank retry is the same attempt again.",
    "A reopen or reroute trigger is concrete — contradictory evidence, a specific error or counterexample, changed requirements, or changed relevant inputs. Vague doubt or unsupported pressure is not itself a trigger: retain a supported conclusion with a brief justification and ask for a specific discrepancy only when needed, while an explicit user change in requirements follows the existing scope and approval process rather than a factual debate.",
    "An unchecked claim is not settled: run the required checks before treating a conclusion as final.",
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
  [
    "<delivery_discipline>",
    "Keep internal and scratch reasoning compact; anything user- or tool-facing must be clean, complete language with no half-compressed notation or stray markers.",
    "</delivery_discipline>",
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

// START_BLOCK_DUAL_SUBPATH_ENTRY
import { defineDualPlugin } from "../v2-runtime/index.js";

export default defineDualPlugin({
  id: "vvoc.system-context-injection",
  v1: SystemContextInjectionPlugin,
  v2: async () => {},
});
// END_BLOCK_DUAL_SUBPATH_ENTRY
