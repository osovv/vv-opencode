// FILE: src/plugins/peak-hours/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Warn or block chat.message requests whose model provider is in configured peak hours, with dynamic off-peak provider suggestions and session-age plus subagent grace.
//   SCOPE: Startup vvoc snapshot resolution and peak-hours entry parsing, internal and subagent-like agent exemptions, persisted-session grace lookup, connected provider enumeration with bounded fallback, soft system-note injection, hard blocking errors, and fail-open degradation.
//   DEPENDS: [@opencode-ai/plugin, src/lib/config-layers.ts, src/lib/plugin-toggle-config.ts, src/lib/managed-agents.ts, src/lib/peak-hours.ts]
//   LINKS: [M-PLUGIN-PEAK-HOURS, M-PEAK-HOURS-SCHEDULES, M-PLUGIN-TOGGLE-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PeakHoursPluginDependencies - Injectable clock, entry, session, provider, and logging dependencies for focused tests.
//   SessionGraceInfo - Persisted session fields used for grace decisions.
//   buildHardBlockMessage - Composes the blocking error text with window end, wait, and suggestions.
//   buildSoftSystemNote - Composes the bounded model-facing peak notice.
//   appendSystemNote - Appends the notice once without duplicating it.
//   createPeakHoursPlugin - Builds the peak-hours server plugin with injectable dependencies.
//   PeakHoursPlugin - Default production peak-hours server plugin.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-PLUGIN-PEAK-HOURS - Added the peak-hours chat.message plugin with soft notes, hard blocks, suggestions, and grace.]
// END_CHANGE_SUMMARY

import type { Plugin } from "@opencode-ai/plugin";
import { loadVvocConfig } from "../../lib/config-layers.js";
import { MANAGED_SUBAGENT_NAMES } from "../../lib/managed-agents.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
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
} from "../../lib/peak-hours.js";

// OpenCode internal agents that must never be gated; blocking them breaks
// session machinery itself.
const INTERNAL_AGENTS = ["compaction", "title", "summary"] as const;
const BUILT_IN_SUBAGENTS = ["general"] as const;
const PLUGIN_MANAGED_SUBAGENTS = ["guardian"] as const;

const PEAK_HOURS_SERVICE = "peak-hours";
const PEAK_HOURS_NOTE_TAG = "<peak_hours_notice>";
const PROVIDER_CACHE_TTL_MS = 10 * 60 * 1_000;
const PROVIDER_FETCH_TIMEOUT_MS = 5_000;
const MAX_LOG_TEXT_CHARS = 500;

export type SessionGraceInfo = {
  createdMs?: number;
  parentID?: string;
};

export type PeakHoursPluginDependencies = {
  now: PeakHoursClock;
  loadEntry: () => Promise<{ entry: PeakHoursEntryConfig; warnings: string[] }>;
  session: (sessionID: string) => Promise<SessionGraceInfo | undefined>;
  connectedProviders: () => Promise<string[]>;
  log: (level: "info" | "warn", message: string, extra?: Record<string, unknown>) => Promise<void>;
};

// START_BLOCK_AGENT_EXEMPTIONS
function createKnownSubagentSet(): Set<string> {
  return new Set<string>([
    ...BUILT_IN_SUBAGENTS,
    ...PLUGIN_MANAGED_SUBAGENTS,
    ...MANAGED_SUBAGENT_NAMES,
  ]);
}

function syncConfiguredSubagents(
  configAgentNames: Record<string, unknown>,
  knownSubagents: Set<string>,
): void {
  for (const [name, definition] of Object.entries(configAgentNames)) {
    if (
      definition &&
      typeof definition === "object" &&
      (definition as { mode?: unknown }).mode === "subagent"
    ) {
      knownSubagents.add(name);
    }
  }
}

function isInternalAgent(agentName: string | undefined): boolean {
  return !!agentName && (INTERNAL_AGENTS as readonly string[]).includes(agentName);
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

// START_CONTRACT: buildSoftSystemNote
//   PURPOSE: Compose the bounded model-facing notice for soft mode.
//   INPUTS: { providerID: string - peak provider id; peak: ActivePeak - active window hit }
//   OUTPUTS: { string - single-line tagged system notice }
//   SIDE_EFFECTS: none
//   LINKS: formatPeakEndTime
// END_CONTRACT: buildSoftSystemNote
export function buildSoftSystemNote(providerID: string, peak: ActivePeak): string {
  const until = formatPeakEndTime(peak.endsAt);
  return `${PEAK_HOURS_NOTE_TAG}Provider "${providerID}" is in peak hours until ${until}; pricing is elevated. Keep responses focused and avoid unnecessary verbosity.</${PEAK_HOURS_NOTE_TAG.slice(1)}`;
}

// START_CONTRACT: appendSystemNote
//   PURPOSE: Append the peak notice to an existing system prompt exactly once.
//   INPUTS: { existingSystem: string | undefined - current system prompt; note: string - composed notice }
//   OUTPUTS: { string - system prompt with the notice appended at most once }
//   SIDE_EFFECTS: none
//   LINKS: buildSoftSystemNote
// END_CONTRACT: appendSystemNote
export function appendSystemNote(existingSystem: string | undefined, note: string): string {
  if (typeof existingSystem === "string" && existingSystem.includes(PEAK_HOURS_NOTE_TAG)) {
    return existingSystem;
  }
  const parts: string[] = [];
  if (typeof existingSystem === "string" && existingSystem.trim()) {
    parts.push(existingSystem.trim());
  }
  parts.push(note);
  return parts.join("\n\n");
}

// START_BLOCK_DEFAULT_DEPENDENCIES
function truncateLogText(value: string): string {
  return value.length > MAX_LOG_TEXT_CHARS ? `${value.slice(0, MAX_LOG_TEXT_CHARS)}...` : value;
}

async function lookupSessionGrace(
  client: Parameters<Plugin>[0]["client"],
  directory: string,
  sessionID: string,
): Promise<SessionGraceInfo | undefined> {
  try {
    const response = (await client.session.get({
      path: { id: sessionID },
      query: directory ? { directory } : undefined,
    } as Parameters<typeof client.session.get>[0])) as { data?: unknown; error?: unknown };
    if (response.error || response.data === undefined) return undefined;
    const session = response.data as {
      parentID?: string;
      time?: { created?: number };
    };
    return {
      createdMs: typeof session.time?.created === "number" ? session.time.created : undefined,
      parentID: typeof session.parentID === "string" ? session.parentID : undefined,
    };
  } catch {
    return undefined;
  }
}

async function listConnectedProviders(
  client: Parameters<Plugin>[0]["client"],
  serverUrl: URL,
  directory: string,
): Promise<string[]> {
  // Prefer a typed client surface when the host SDK exposes one.
  const configClient = (
    client as {
      config?: {
        providers?: (input: unknown) => Promise<{ data?: { providers?: Array<{ id?: string }> } }>;
      };
    }
  ).config;
  if (typeof configClient?.providers === "function") {
    try {
      const response = await configClient.providers(
        directory ? { query: { directory } } : undefined,
      );
      const providers = response.data?.providers ?? [];
      return providers
        .map((provider) => provider.id)
        .filter((id): id is string => typeof id === "string");
    } catch {
      // Fall through to the raw HTTP fallback.
    }
  }

  try {
    const url = new URL("/config/providers", serverUrl);
    if (directory) {
      url.searchParams.set("directory", directory);
    }
    const response = await fetch(url, {
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { providers?: Array<{ id?: string }> };
    const providers = body.providers ?? [];
    return providers
      .map((provider) => provider.id)
      .filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}
// END_BLOCK_DEFAULT_DEPENDENCIES

// START_BLOCK_PLUGIN_ENTRY
/**
 * Builds the peak-hours OpenCode server plugin.
 *
 * chat.message evaluates the message model's provider against the configured
 * schedules. Soft mode appends a bounded system notice; hard mode throws before
 * any LLM request with dynamic off-peak suggestions. Internal agents, subagent
 * agents, sessions with a parentID, and sessions created before the active
 * window start are never hard-blocked. Schedule and lookup failures degrade to
 * soft or no-op and never block.
 */
export function createPeakHoursPlugin(
  dependencies: Partial<PeakHoursPluginDependencies> = {},
): Plugin {
  return async ({ client, directory, serverUrl }) => {
    const providerCache: { at: number; ids: string[] } = { at: 0, ids: [] };

    const deps: PeakHoursPluginDependencies = {
      now: () => new Date(),
      loadEntry: async () => {
        const vvoc = await loadVvocConfig({ cwd: directory });
        if (!isVvocPluginEnabled(vvoc.config, "peak-hours")) {
          return { entry: { ...parsePeakHoursEntry(false).entry }, warnings: [] };
        }
        return parsePeakHoursEntry(vvoc.config.plugins?.["peak-hours"]);
      },
      session: (sessionID) => lookupSessionGrace(client, directory, sessionID),
      connectedProviders: async () => {
        const now = Date.now();
        if (now - providerCache.at < PROVIDER_CACHE_TTL_MS) {
          return providerCache.ids;
        }
        const ids = await listConnectedProviders(client, serverUrl, directory);
        providerCache.at = ids.length > 0 ? Date.now() : 0;
        providerCache.ids = ids;
        return ids;
      },
      log: async (level, message, extra) => {
        try {
          await client.app.log({
            ...(directory ? { query: { directory } } : {}),
            body: {
              service: PEAK_HOURS_SERVICE,
              level,
              message: truncateLogText(message),
              extra,
            },
          });
        } catch {
          // Logging must never interfere with message handling.
        }
      },
      ...dependencies,
    };

    const { entry, warnings } = await deps.loadEntry();
    if (!entry.enabled) return {};

    const knownSubagents = createKnownSubagentSet();

    await deps.log("info", "peak-hours plugin initialized", {
      mode: entry.mode,
      graceActiveSessions: entry.graceActiveSessions,
      scheduledProviders: Object.keys(entry.schedules),
      warningCount: warnings.length,
    });
    for (const warning of warnings) {
      await deps.log("warn", `peak-hours config warning: ${warning}`);
    }

    return {
      config: async (config) => {
        syncConfiguredSubagents((config.agent ?? {}) as Record<string, unknown>, knownSubagents);
      },
      "chat.message": async (input, output) => {
        const agent = output.message.agent ?? input.agent;
        if (isInternalAgent(agent)) return;

        const providerID = input.model?.providerID ?? output.message.model?.providerID;
        if (!providerID) return;

        const now = deps.now();
        const peak = findActivePeak(now, entry.schedules, providerID);
        if (!peak) return;

        const override = entry.schedules[peak.providerKey]?.mode;
        let mode: PeakHoursMode = override ?? entry.mode;

        // Subagent-like agents are continuation of already-admitted work.
        if (agent && knownSubagents.has(agent)) {
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

        if (mode === "hard") {
          const connected = await deps.connectedProviders();
          const suggestions = suggestOffPeakProviders(now, entry.schedules, connected).filter(
            (candidate) => normalizeProviderId(candidate) !== normalizeProviderId(providerID),
          );
          const message = buildHardBlockMessage(providerID, peak, suggestions);
          await deps.log("info", "peak-hours hard block applied", {
            providerID,
            providerKey: peak.providerKey,
            until: formatPeakEndTime(peak.endsAt),
            waitMinutes: peak.minutesRemaining,
            suggestions,
            sessionID: input.sessionID,
          });
          throw new Error(message);
        }

        output.message.system = appendSystemNote(
          output.message.system,
          buildSoftSystemNote(providerID, peak),
        );
        await deps.log("info", "peak-hours soft notice applied", {
          providerID,
          providerKey: peak.providerKey,
          until: formatPeakEndTime(peak.endsAt),
          sessionID: input.sessionID,
        });
      },
    };
  };
}

export const PeakHoursPlugin: Plugin = createPeakHoursPlugin();
// END_BLOCK_PLUGIN_ENTRY
