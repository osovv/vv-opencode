// FILE: src/plugins/system-context-injection/index.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Deliver canonical controller guidance and its shared primary projection once, plus the session-settings-resolved controller policy at the request tail, through the native session context hook.
//   SCOPE: Startup-local bundled guidance loading; line-ending-tolerant exact-text deduplication against the complete seven-section controller template without rewriting host content; shared project, memory, evidence, working-cycle, authority and delivery guidance for other primary agents; controller-only task/delegation/communication isolation; explore guidance exception; all other subagent and internal-agent exclusions; fresh registry reads; session settings and plugin toggle resolution; transient user-tail policy; lifecycle cleanup. Native skill discovery and workflow protocol injection retain their existing owners.
//   DEPENDS: [@opencode/plugin, src/lib/managed-agents.ts, src/lib/orchestration.ts, src/runtime/context.ts, src/runtime/session-settings.ts, ./guidance.ts]
//   LINKS: [M-PLUGIN-SYSTEM-CONTEXT-INJECTION, M-ORCHESTRATION-PROFILES, M-CLI-MANAGED-AGENTS, M-NATIVE-RUNTIME, V-M-PLUGIN-SYSTEM-CONTEXT-INJECTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SystemContextInjectionPluginOptions - Optional injectable runtime acquisition and diagnostic sink for tests.
//   createSystemContextInjectionPlugin - Native plugin factory; the default export acquires the real shared runtime.
//   SystemContextInjectionPlugin - Default production native system-context-injection plugin object.
//   default - Default export alias of SystemContextInjectionPlugin.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Use the approved controller template as the single wording source, project shared instructions to other primaries, and avoid reinjecting sections already supplied by the host.]
// END_CHANGE_SUMMARY

import { SystemPart } from "@opencode/ai";
import { Plugin } from "@opencode/plugin";
import {
  loadManagedAgentPromptTemplate,
  MANAGED_SUBAGENT_NAMES,
} from "../../lib/managed-agents.js";
import {
  resolveOrchestrationPolicy,
  type ResolvedOrchestrationPolicy,
} from "../../lib/orchestration.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import {
  acquireNativeSnapshotRuntime,
  type NativeSnapshotContext,
  type NativeSnapshotRuntime,
} from "../../runtime/context.js";
import type { FamilySettingsView } from "../../runtime/session-settings.js";
import { createPrimarySystemContexts, type PrimarySystemContexts } from "./guidance.js";

const BUILT_IN_SUBAGENTS = ["general"] as const;
const PLUGIN_MANAGED_SUBAGENTS = ["guardian"] as const;
const INTERNAL_PRIMARY_AGENTS = ["compaction", "title", "summary"] as const;
const SELF_SUFFICIENT_PRIMARY_AGENTS = [] as const;
const EXPLORE_SUBAGENT = "explore" as const;
const VV_CONTROLLER_AGENT = "vv-controller" as const;

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

export interface SystemContextInjectionPluginOptions {
  /** Test-only injectable runtime acquisition. Default acquires the real shared runtime. */
  acquireRuntime?: (ctx: NativeSnapshotContext) => Promise<NativeSnapshotRuntime>;
}

// START_BLOCK_AGENT_FILTERS
function createKnownSubagentSet(): Set<string> {
  return new Set([...BUILT_IN_SUBAGENTS, ...PLUGIN_MANAGED_SUBAGENTS, ...MANAGED_SUBAGENT_NAMES]);
}

function isInternalPrimaryAgent(agentName: string): boolean {
  return (INTERNAL_PRIMARY_AGENTS as readonly string[]).includes(agentName);
}

async function shouldInjectForAgent(
  agentName: string | undefined,
  knownSubagents: Set<string>,
  agentMode: (agent: string) => Promise<"subagent" | "primary" | "all" | undefined>,
): Promise<boolean> {
  if (!agentName) return false;
  // The built-in explore worker is a native subagent but intentionally receives
  // its own role guidance; it is the one subagent that is not excluded here.
  if (agentName === EXPLORE_SUBAGENT) return true;
  if (knownSubagents.has(agentName)) return false;
  if (isInternalPrimaryAgent(agentName)) return false;
  if (
    SELF_SUFFICIENT_PRIMARY_AGENTS.includes(
      agentName as (typeof SELF_SUFFICIENT_PRIMARY_AGENTS)[number],
    )
  ) {
    return false;
  }
  // A custom agent registered as a native subagent is excluded by its real mode,
  // not by name alone.
  try {
    if ((await agentMode(agentName)) === "subagent") return false;
  } catch {
    // A registry lookup failure leaves the name-based decision in force.
  }
  return true;
}

/** Returns the stable guidance injected into the system prefix for one agent. */
function getSystemContextsForAgent(
  agentName: string | undefined,
  guidance: PrimarySystemContexts,
): readonly string[] {
  if (agentName === EXPLORE_SUBAGENT) {
    return EXPLORE_SYSTEM_CONTEXTS;
  }
  return agentName === VV_CONTROLLER_AGENT ? guidance.controller : guidance.universal;
}

/**
 * Returns the variable orchestration policy for one agent, or undefined when the
 * agent gets none. It is injected at the request tail, never into the system
 * prefix, so changing the profile does not invalidate the cached prefix.
 */
function getTailPolicyForAgent(
  agentName: string | undefined,
  policy: ResolvedOrchestrationPolicy,
): string | undefined {
  if (agentName !== VV_CONTROLLER_AGENT) return undefined;
  return policy.controllerSystemContext;
}
// END_BLOCK_AGENT_FILTERS

// START_BLOCK_SYSTEM_CONTEXT_FORMATTING
/** Native system part text already carrying the context, if any. */
function hasInjectedContext(parts: ReadonlyArray<{ text?: unknown }>, context: string): boolean {
  return parts.some(
    (part) => typeof part.text === "string" && part.text.replace(/\r\n/g, "\n").includes(context),
  );
}

/**
 * Append each context to the native system parts exactly once. Existing parts
 * and their order are preserved; only the provider-context copy the model is
 * about to receive is changed, never the stored user prompt.
 */
function appendSystemContexts(
  system: Array<{ type: "text"; text: string }>,
  contexts: readonly string[],
): void {
  for (const context of contexts) {
    if (hasInjectedContext(system, context)) continue;
    system.push(SystemPart.make(context));
  }
}

/**
 * Append the variable orchestration policy to the tail of the request exactly
 * once, but only when the last message is a user turn. The part is transient:
 * it changes only the provider copy, so it never lands in stored history, and
 * keeping it out of the system prefix means a profile change does not
 * invalidate the cached prefix. Injecting into a tool or assistant message
 * would corrupt the provider payload shape, and mid-turn continuation requests
 * keep the guidance already delivered at the turn's user message.
 */
function appendTailContext(
  messages: Array<{ role?: unknown; content?: unknown }>,
  context: string,
): void {
  if (messages.length === 0) return;
  const last = messages[messages.length - 1];
  if (last === null || typeof last !== "object") return;
  if (String((last as { role?: unknown }).role ?? "") !== "user") return;
  const content = (last as { content?: unknown }).content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string" && text.includes(context)) return;
  }
  content.push({ type: "text", text: context });
}
// END_BLOCK_SYSTEM_CONTEXT_FORMATTING

// START_BLOCK_POLICY
async function resolveCapturedConfig(
  runtime: NativeSnapshotRuntime,
  sessionID: string,
): Promise<FamilySettingsView["vvoc"] | undefined> {
  let view: FamilySettingsView | undefined;
  try {
    view = await runtime.settings.configFor(sessionID);
  } catch {
    return undefined;
  }
  if (view === undefined) return undefined;
  if (!isVvocPluginEnabled(view.vvoc, "system-context-injection")) return undefined;
  return view.vvoc;
}
// END_BLOCK_POLICY

// START_BLOCK_PLUGIN_ENTRY
/** Native plugin factory; the default export acquires the real shared runtime. */
export function createSystemContextInjectionPlugin(
  options: SystemContextInjectionPluginOptions = {},
): Plugin.Plugin {
  return Plugin.define({
    id: "vvoc.system-context-injection",
    setup: async (ctx) => {
      const guidance = createPrimarySystemContexts(
        await loadManagedAgentPromptTemplate("vv-controller"),
      );
      const acquire =
        options.acquireRuntime ?? ((c: NativeSnapshotContext) => acquireNativeSnapshotRuntime(c));
      const runtime = await acquire(ctx);
      const knownSubagents = createKnownSubagentSet();

      /**
       * Read one agent's native registry mode. The read is intentionally fresh on
       * every query: a transient registry failure must not poison later requests,
       * and a newly configured subagent or a changed mode must take effect without
       * a process restart. Returns undefined when the agent is unknown or the
       * registry is unavailable.
       */
      const agentMode = async (
        agent: string,
      ): Promise<"subagent" | "primary" | "all" | undefined> => {
        try {
          const result = (await ctx.agent.list()) as unknown;
          const data = Array.isArray(result)
            ? result
            : ((result as { data?: unknown } | undefined)?.data ?? undefined);
          if (!Array.isArray(data)) return undefined;
          for (const item of data) {
            if (typeof item !== "object" || item === null) continue;
            const record = item as { id?: unknown; mode?: unknown };
            if (String(record.id) !== agent) continue;
            if (record.mode === "subagent" || record.mode === "primary" || record.mode === "all") {
              return record.mode;
            }
            return undefined;
          }
          return undefined;
        } catch {
          return undefined;
        }
      };

      const registration = await ctx.session.hook("context", async (event) => {
        try {
          const agentName = event.agent === undefined ? undefined : String(event.agent);
          if (!(await shouldInjectForAgent(agentName, knownSubagents, agentMode))) return;
          const config = await resolveCapturedConfig(runtime, String(event.sessionID));
          if (config === undefined) return;
          const policy = resolveOrchestrationPolicy(config);
          if (Array.isArray(event.system)) {
            appendSystemContexts(
              event.system as Array<{ type: "text"; text: string }>,
              getSystemContextsForAgent(agentName, guidance),
            );
          }
          const tail = getTailPolicyForAgent(agentName, policy);
          if (tail !== undefined && Array.isArray(event.messages)) {
            appendTailContext(event.messages as Array<{ role?: unknown; content?: unknown }>, tail);
          }
        } catch {
          // Guidance injection must never fail a model request.
        }
      });

      return async () => {
        await registration.dispose();
        await runtime.release();
      };
    },
  });
}

export const SystemContextInjectionPlugin: Plugin.Plugin = createSystemContextInjectionPlugin();
export default SystemContextInjectionPlugin;
// END_BLOCK_PLUGIN_ENTRY
