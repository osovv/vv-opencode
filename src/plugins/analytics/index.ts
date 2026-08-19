// FILE: src/plugins/analytics/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Collect per-step token usage telemetry and session metadata into the analytics store with vvoc and OpenCode version attribution.
//   SCOPE: Plugin toggle gating, assistant message attribution tracking, session version tracking, step-finish usage records, session records, and fail-soft event handling.
//   DEPENDS: [@opencode-ai/plugin, src/lib/config-layers.ts, src/lib/package.ts, src/lib/plugin-toggle-config.ts, src/lib/analytics/store.ts, src/lib/analytics/types.ts]
//   LINKS: [M-PLUGIN-ANALYTICS, M-ANALYTICS-STORE, M-ANALYTICS-TYPES, M-PLUGIN-TOGGLE-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   AnalyticsPluginDependencies - Injectable enablement and append dependencies for focused tests.
//   createAnalyticsPlugin - Builds an OpenCode server plugin with injectable dependencies.
//   AnalyticsPlugin - Default production analytics server plugin.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-19-cache-hit-rate-analytics - Added step-finish telemetry collection with session-derived OpenCode version attribution.]
// END_CHANGE_SUMMARY

import type { Event, Part } from "@opencode-ai/sdk";
import type { Plugin } from "@opencode-ai/plugin";
import { loadVvocConfig } from "../../lib/config-layers.js";
import { getPackageVersionSync } from "../../lib/package.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import { appendAnalyticsRecord } from "../../lib/analytics/store.js";
import type { AnalyticsRecord, UsageRecord } from "../../lib/analytics/types.js";

type MessageAttribution = {
  providerID: string;
  modelID: string;
  agent: string;
};

export type AnalyticsPluginDependencies = {
  enabled: (directory: string) => Promise<boolean>;
  append: (record: AnalyticsRecord) => Promise<void>;
};

const DEFAULT_DEPENDENCIES: AnalyticsPluginDependencies = {
  enabled: async (directory) => {
    const vvoc = await loadVvocConfig({ cwd: directory });
    return isVvocPluginEnabled(vvoc.config, "analytics");
  },
  append: (record) => appendAnalyticsRecord(record),
};

// START_BLOCK_CREATE_ANALYTICS_PLUGIN
/**
 * Builds the analytics OpenCode server plugin.
 * Enabled: appends one usage record per step-finish part update and one session
 * record per session.created/session.updated event. OpenCode version attribution
 * comes from Session.version seen on session events (cached per sessionID,
 * "unknown" before the first session event). Model/provider/agent attribution
 * comes from an in-memory messageID map maintained from message.updated events,
 * falling back to empty strings when a part arrives before its message was seen.
 * All handler errors are swallowed and logged to stderr at most once.
 */
export function createAnalyticsPlugin(
  dependencies: Partial<AnalyticsPluginDependencies> = {},
): Plugin {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  return async ({ directory, project }) => {
    if (!(await deps.enabled(directory))) return {};

    const vvocVersion = getPackageVersionSync();
    const messageAttribution = new Map<string, MessageAttribution>();
    const sessionOpencodeVersions = new Map<string, string>();
    let loggedFailure = false;

    const failSoft = async (operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        if (!loggedFailure) {
          loggedFailure = true;
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[vvoc analytics] collection error: ${message}`);
        }
      }
    };

    return {
      event: async ({ event }) => {
        await failSoft(async () => {
          if (event.type === "message.updated") {
            handlemessageUpdated(event, messageAttribution);
            return;
          }
          if (event.type === "message.part.updated") {
            await handleMessagePartUpdated({
              part: event.properties.part,
              projectID: project.id,
              projectDirectory: directory,
              vvocVersion,
              sessionOpencodeVersions,
              messageAttribution,
              append: deps.append,
            });
            return;
          }
          if (event.type === "session.created" || event.type === "session.updated") {
            const info = event.properties.info;
            sessionOpencodeVersions.set(info.id, info.version || "unknown");
            await deps.append({
              kind: "session",
              ts: new Date().toISOString(),
              sessionID: info.id,
              projectID: project.id,
              title: info.title ?? "",
            });
          }
        });
      },
    };
  };
}
// END_BLOCK_CREATE_ANALYTICS_PLUGIN

export const AnalyticsPlugin: Plugin = createAnalyticsPlugin();

// START_BLOCK_EVENT_HANDLERS
/** Records assistant model/provider/agent attribution by messageID. */
function handlemessageUpdated(
  event: Extract<Event, { type: "message.updated" }>,
  attribution: Map<string, MessageAttribution>,
): void {
  const info = event.properties.info;
  if (info.role !== "assistant") return;
  const agent = (info as { agent?: unknown }).agent;
  attribution.set(info.id, {
    providerID: info.providerID ?? "",
    modelID: info.modelID ?? "",
    agent: typeof agent === "string" ? agent : "",
  });
}

/** Appends one usage record when the part is a completed step-finish part. */
async function handleMessagePartUpdated(input: {
  part: Part;
  projectID: string;
  projectDirectory: string;
  vvocVersion: string;
  sessionOpencodeVersions: Map<string, string>;
  messageAttribution: Map<string, MessageAttribution>;
  append: (record: AnalyticsRecord) => Promise<void>;
}): Promise<void> {
  const { part } = input;
  if (part.type !== "step-finish") return;
  const tokens = (part.tokens ?? {}) as {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    cache?: { read?: unknown; write?: unknown };
  };
  const cost = part.cost as unknown;
  const attribution = input.messageAttribution.get(part.messageID);
  const record: UsageRecord = {
    kind: "usage",
    ts: new Date().toISOString(),
    projectID: input.projectID,
    projectDirectory: input.projectDirectory,
    sessionID: part.sessionID,
    messageID: part.messageID,
    partID: part.id,
    providerID: attribution?.providerID ?? "",
    modelID: attribution?.modelID ?? "",
    agent: attribution?.agent ?? "",
    tokens: {
      input: toCount(tokens.input),
      output: toCount(tokens.output),
      reasoning: toCount(tokens.reasoning),
      cacheRead: toCount(tokens.cache?.read),
      cacheWrite: toCount(tokens.cache?.write),
    },
    cost: typeof cost === "number" && Number.isFinite(cost) ? cost : 0,
    vvocVersion: input.vvocVersion,
    opencodeVersion: input.sessionOpencodeVersions.get(part.sessionID) ?? "unknown",
  };
  await input.append(record);
}

/** Normalizes an untrusted token counter to a finite non-negative number. */
function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
// END_BLOCK_EVENT_HANDLERS
