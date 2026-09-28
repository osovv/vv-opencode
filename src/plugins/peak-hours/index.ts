// FILE: src/plugins/peak-hours/index.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Hard-block native primary model requests whose provider is in configured peak hours before any provider call, with dynamic off-peak provider suggestions and session-age plus subagent grace; soft mode never mutates the request.
//   SCOPE: Native Plugin.define entry, native session model.request hook after prompt admission, per-bound-family policy resolution from the immutable captured config (never a startup-global toggle), internal-kind and subagent-like agent exemptions read fresh from the native registry, persisted-session grace through the native client, authenticated native provider registry enumeration, hard blocking by throwing before dispatch, soft pass-through with no prompt mutation, and fail-open degradation. No raw unauthenticated provider HTTP fallback, no V1 chat.params facade, and no cross-request agent-mode cache.
//   DEPENDS: [@opencode/plugin, src/lib/managed-agents.ts, src/runtime/context.ts, src/runtime/types.ts, src/lib/peak-hours.ts]
//   LINKS: [M-PLUGIN-PEAK-HOURS, M-PEAK-HOURS-SCHEDULES, M-NATIVE-RUNTIME, V-M-PLUGIN-PEAK-HOURS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SessionGraceInfo - Persisted session fields used for grace decisions.
//   PeakHoursPluginDependencies - Injectable clock, policy, session, agent-mode, provider, and logging dependencies for focused tests.
//   buildHardBlockMessage - Composes the blocking error text with window end, wait, and suggestions.
//   PeakHoursPluginOptions - Injectable runtime acquisition plus dependency overrides.
//   createPeakHoursPlugin - Builds the native peak-hours plugin with injectable dependencies.
//   PeakHoursPlugin - Default production native peak-hours plugin.
//   default - Default export alias of PeakHoursPlugin.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-006 attempt 2 - Native agent mode is read fresh per query (no poisoning cache); added default session/provider adapter coverage and the loopback real-host smoke.]
// END_CHANGE_SUMMARY

import { Plugin } from "@opencode/plugin";
import { MANAGED_SUBAGENT_NAMES } from "../../lib/managed-agents.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import {
  acquireNativeSnapshotRuntime,
  type NativeSnapshotContext,
  type NativeSnapshotRuntime,
} from "../../runtime/context.js";
import type { FamilyCapture } from "../../runtime/types.js";
import {
  findActivePeak,
  formatPeakEndTime,
  formatWaitMinutes,
  normalizeProviderId,
  parsePeakHoursEntry,
  suggestOffPeakProviders,
  type ActivePeak,
  type PeakHoursClock,
  type PeakHoursEntryConfig,
  type PeakHoursMode,
  type PeakSchedules,
} from "../../lib/peak-hours.js";

// OpenCode internal agents that must never be gated; blocking them breaks
// session machinery itself.
const INTERNAL_AGENTS = ["compaction", "title", "summary"] as const;
const BUILT_IN_SUBAGENTS = ["general"] as const;
const PLUGIN_MANAGED_SUBAGENTS = ["guardian"] as const;
/**
 * The native request kind distinguishes the agent loop from auxiliary work.
 * Only the primary loop is a user-costly provider request; compaction, title and
 * generate are session machinery that must never be interrupted by peak gating.
 */
const HARD_GATED_KIND = "primary";
const PEAK_HOURS_SERVICE = "peak-hours";
const MAX_LOG_TEXT_CHARS = 500;

export type SessionGraceInfo = {
  createdMs?: number;
  parentID?: string;
};

export interface PeakHoursPluginDependencies {
  now: PeakHoursClock;
  session: (sessionID: string) => Promise<SessionGraceInfo | undefined>;
  /** Native registry agent mode, used to exempt custom subagent agents. */
  agentMode: (agent: string) => Promise<"subagent" | "primary" | "all" | undefined>;
  connectedProviders: () => Promise<string[]>;
  log: (level: "info" | "warn", message: string, extra?: Record<string, unknown>) => void;
}

export interface PeakHoursPluginOptions extends Partial<PeakHoursPluginDependencies> {
  /** Test-only injectable runtime acquisition. Default acquires the real shared runtime. */
  acquireRuntime?: (ctx: NativeSnapshotContext) => Promise<NativeSnapshotRuntime>;
}

// START_BLOCK_AGENT_EXEMPTIONS
function createKnownSubagentSet(): Set<string> {
  return new Set<string>([
    ...BUILT_IN_SUBAGENTS,
    ...PLUGIN_MANAGED_SUBAGENTS,
    ...MANAGED_SUBAGENT_NAMES,
  ]);
}

function isInternalAgent(agentName: string | undefined): boolean {
  return !!agentName && (INTERNAL_AGENTS as readonly string[]).includes(agentName);
}

/** True when the agent is a subagent by known name or native registry mode. */
async function isSubagentLike(
  agent: string | undefined,
  knownSubagents: Set<string>,
  agentMode: PeakHoursPluginDependencies["agentMode"],
): Promise<boolean> {
  if (!agent) return false;
  if (knownSubagents.has(agent)) return true;
  try {
    return (await agentMode(agent)) === "subagent";
  } catch {
    return false;
  }
}
// END_BLOCK_AGENT_EXEMPTIONS

// START_CONTRACT: buildHardBlockMessage
//   PURPOSE: Compose the hard-mode blocking error text with window end, wait time, and suggestions.
//   INPUTS: { providerID: string - peak provider id; peak: ActivePeak - active window hit; suggestions: readonly string[] - connected off-peak provider ids }
//   OUTPUTS: { string - complete blocking error message }
//   SIDE_EFFECTS: none
//   LINKS: formatPeakEndTime, formatWaitMinutes
// END_CONTRACT: buildHardBlockMessage
export function buildHardBlockMessage(
  providerID: string,
  peak: ActivePeak,
  suggestions: readonly string[],
): string {
  const until = formatPeakEndTime(peak.endsAt);
  const wait = formatWaitMinutes(peak.minutesRemaining);
  const lines = [
    `PEAK_HOURS_BLOCK: provider "${providerID}" is in peak hours until ${until} (about ${wait}).`,
    "Requests to this provider cost more right now.",
  ];
  if (suggestions.length > 0) {
    lines.push(
      `Connected providers outside peak hours right now: ${suggestions.join(", ")}. Switch the model to one of them, or wait.`,
    );
  } else {
    lines.push(
      "Every connected provider is currently in peak hours or unscheduled; wait for the window to end or review the plugins[peak-hours] schedules in vvoc.json.",
    );
  }
  return lines.join(" ");
}

// START_BLOCK_DEFAULT_DEPENDENCIES
function truncateLogText(value: string): string {
  return value.length > MAX_LOG_TEXT_CHARS ? `${value.slice(0, MAX_LOG_TEXT_CHARS)}...` : value;
}

function createConsoleLog(): PeakHoursPluginDependencies["log"] {
  return (level, message, extra) => {
    const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
    console.error(`[${PEAK_HOURS_SERVICE}][${level}] ${truncateLogText(`${message}${suffix}`)}`);
  };
}

async function lookupSessionGrace(
  ctx: Plugin.Context,
  sessionID: string,
): Promise<SessionGraceInfo | undefined> {
  try {
    const session = (await ctx.session.get({ sessionID })) as {
      parentID?: unknown;
      time?: { created?: unknown };
    };
    return {
      createdMs:
        typeof session.time?.created === "number" && Number.isFinite(session.time.created)
          ? session.time.created
          : undefined,
      parentID: typeof session.parentID === "string" ? session.parentID : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Enumerate providers from the authenticated native registry (never a raw HTTP fallback). */
async function listConnectedProviders(ctx: Plugin.Context): Promise<string[]> {
  try {
    const result = (await ctx.provider.list()) as unknown;
    const data = Array.isArray(result) ? result : (result as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(data)) return [];
    return data
      .map((provider) =>
        typeof provider === "object" && provider !== null
          ? (provider as { id?: unknown }).id
          : undefined,
      )
      .filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}
// END_BLOCK_DEFAULT_DEPENDENCIES

// START_BLOCK_POLICY
async function resolveEntry(
  runtime: NativeSnapshotRuntime,
  sessionID: string,
): Promise<{ entry: PeakHoursEntryConfig; warnings: string[] } | undefined> {
  const read = async (): Promise<FamilyCapture | undefined> => {
    try {
      return await runtime.snapshots.configFor(sessionID);
    } catch {
      return undefined;
    }
  };
  let capture = await read();
  if (capture === undefined) {
    try {
      await runtime.snapshots.accept({ sessionID });
    } catch {
      // fall through to the second read; absence is unknown policy below
    }
    capture = await read();
  }
  if (capture === undefined) return undefined;
  if (!isVvocPluginEnabled(capture.vvoc, "peak-hours")) return undefined;
  return parsePeakHoursEntry(capture.vvoc.plugins?.["peak-hours"]);
}
// END_BLOCK_POLICY

// START_BLOCK_PLUGIN_ENTRY
type PeakDecision = {
  peak: ActivePeak;
  mode: PeakHoursMode;
  schedules: PeakSchedules;
};

/**
 * Builds the native peak-hours plugin.
 *
 * Soft mode is pass-through: the plugin never mutates the system parts or
 * messages, and peak cost state stays visible only through the TUI banner. The
 * `model.request` hook enforces the hard block by throwing before the provider
 * request is dispatched. Internal kinds (title/compaction/generate), internal
 * agents, subagent-like agents, sessions with a parentID, and sessions created
 * before the active window start are never hard-blocked. Unknown family policy,
 * schedule, or session lookup failures degrade to soft or no-op and never block.
 */
export function createPeakHoursPlugin(options: PeakHoursPluginOptions = {}): Plugin.Plugin {
  return Plugin.define({
    id: "vvoc.peak-hours",
    setup: async (ctx) => {
      const acquire =
        options.acquireRuntime ?? ((c: NativeSnapshotContext) => acquireNativeSnapshotRuntime(c));
      const runtime = await acquire(ctx);
      const knownSubagents = createKnownSubagentSet();
      const entryCache = new Map<
        string,
        { entry: PeakHoursEntryConfig; warnings: string[] } | undefined
      >();
      const alerted = new Set<string>();

      /**
       * Read one agent's native registry mode. The read is intentionally fresh on
       * every query so a transient registry failure never poisons later requests
       * and a changed mode or newly configured subagent takes effect without a
       * restart. Returns undefined when the agent is unknown or unavailable.
       */
      const defaultAgentMode: PeakHoursPluginDependencies["agentMode"] = async (agent) => {
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

      const deps: PeakHoursPluginDependencies = {
        now: options.now ?? (() => new Date()),
        session: options.session ?? ((sessionID) => lookupSessionGrace(ctx, sessionID)),
        agentMode: options.agentMode ?? defaultAgentMode,
        connectedProviders: options.connectedProviders ?? (() => listConnectedProviders(ctx)),
        log: options.log ?? createConsoleLog(),
      };

      const entryFor = async (sessionID: string) => {
        if (entryCache.has(sessionID)) return entryCache.get(sessionID);
        const resolved = await resolveEntry(runtime, sessionID);
        if (resolved === undefined) return undefined;
        entryCache.set(sessionID, resolved);
        if (!alerted.has(sessionID)) {
          alerted.add(sessionID);
          deps.log("info", "peak-hours policy bound", {
            mode: resolved.entry.mode,
            graceActiveSessions: resolved.entry.graceActiveSessions,
            scheduledProviders: Object.keys(resolved.entry.schedules),
            warningCount: resolved.warnings.length,
          });
          for (const warning of resolved.warnings) {
            deps.log("warn", `peak-hours config warning: ${warning}`);
          }
        }
        return resolved;
      };

      // Resolves the effective peak decision for one request: peak hit plus the
      // mode after provider overrides, kind/agent exemptions, and persisted-session
      // grace. Returns undefined when the provider is not in peak, the request is
      // not the primary loop, or the agent is internal OpenCode infrastructure.
      const resolvePeakDecision = async (input: {
        agent: string | undefined;
        providerID: string;
        sessionID: string;
        kind: string;
      }): Promise<PeakDecision | undefined> => {
        if (input.kind !== HARD_GATED_KIND) return undefined;
        if (isInternalAgent(input.agent)) return undefined;
        const resolved = await entryFor(input.sessionID);
        if (resolved === undefined || !resolved.entry.enabled) return undefined;
        const entry = resolved.entry;

        const now = deps.now();
        const peak = findActivePeak(now, entry.schedules, input.providerID);
        if (!peak) return undefined;

        const override = entry.schedules[peak.providerKey]?.mode;
        let mode: PeakHoursMode = override ?? entry.mode;

        // Subagent-like agents are continuation of already-admitted work.
        if (await isSubagentLike(input.agent, knownSubagents, deps.agentMode)) {
          mode = "soft";
        }

        if (mode === "hard") {
          const session = await deps.session(input.sessionID);
          if (!session) {
            // Fail-open: unknown session state never blocks.
            mode = "soft";
          } else {
            if (session.parentID) {
              mode = "soft";
            }
            if (
              entry.graceActiveSessions &&
              session.createdMs !== undefined &&
              session.createdMs < peak.startedAt.getTime()
            ) {
              mode = "soft";
            }
          }
        }

        return { peak, mode, schedules: entry.schedules };
      };

      const registration = await ctx.session.hook("model.request", async (event) => {
        const providerID = event.model?.providerID;
        if (providerID === undefined) return;
        const decision = await resolvePeakDecision({
          agent: event.agent === undefined ? undefined : String(event.agent),
          providerID: String(providerID),
          sessionID: String(event.sessionID),
          kind: String(event.kind),
        });
        if (!decision || decision.mode !== "hard") return;

        const now = deps.now();
        const connected = await deps.connectedProviders();
        const suggestions = suggestOffPeakProviders(now, decision.schedules, connected).filter(
          (candidate) => normalizeProviderId(candidate) !== normalizeProviderId(String(providerID)),
        );
        const message = buildHardBlockMessage(String(providerID), decision.peak, suggestions);
        deps.log("info", "peak-hours hard block applied", {
          providerID: String(providerID),
          providerKey: decision.peak.providerKey,
          until: formatPeakEndTime(decision.peak.endsAt),
          waitMinutes: decision.peak.minutesRemaining,
          suggestions,
          sessionID: String(event.sessionID),
        });
        // Throwing here fails the model request before any provider call, after the
        // user message was already persisted, so OpenCode renders the block as a
        // standard error instead of dropping the message.
        throw new Error(message);
      });

      return async () => {
        await registration.dispose();
        await runtime.release();
      };
    },
  });
}

export const PeakHoursPlugin: Plugin.Plugin = createPeakHoursPlugin();
export default PeakHoursPlugin;
// END_BLOCK_PLUGIN_ENTRY
