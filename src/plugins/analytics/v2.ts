// FILE: src/plugins/analytics/v2.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Register the analytics plugin on the OpenCode v2 runtime event stream with per-location enablement.
//   SCOPE: v2 setup only: subscribe to session.step.ended for per-step usage records, session.created for session records, and session.agent.selected for best-effort agent attribution, resolving the analytics toggle from each event's location directory and staying fail-soft on every handler error.
//   DEPENDS: [@opencode/plugin, src/lib/analytics/store.ts, src/lib/analytics/types.ts, src/lib/package.ts, src/plugins/v2-runtime/setup.ts]
//   LINKS: [M-PLUGIN-ANALYTICS, V-M-PLUGIN-ANALYTICS, M-PLUGIN-V2-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   setupAnalyticsV2 - Register the analytics event stream handlers for one OpenCode v2 plugin context.
//   AnalyticsV2Dependencies - Injectable append, version, and enablement dependencies for focused tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-003 - Ported analytics onto the v2 event stream with per-location gating.]
// END_CHANGE_SUMMARY

import type { Plugin as V2Plugin } from "@opencode/plugin";
import type { V2AdapterContext } from "../v2-runtime/setup.js";
import { appendAnalyticsRecord } from "../../lib/analytics/store.js";
import type { AnalyticsRecord, UsageRecord } from "../../lib/analytics/types.js";
import { getPackageVersionSync } from "../../lib/package.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";

// START_BLOCK_ANALYTICS_V2_DEPENDENCIES
export type AnalyticsV2Dependencies = {
  append: (record: AnalyticsRecord) => Promise<void>;
  vvocVersion: string;
};

const DEFAULT_DEPENDENCIES: AnalyticsV2Dependencies = {
  append: (record) => appendAnalyticsRecord(record),
  vvocVersion: getPackageVersionSync(),
};
// END_BLOCK_ANALYTICS_V2_DEPENDENCIES

// START_BLOCK_SETUP_ANALYTICS_V2
/**
 * Register the analytics handlers on the v2 event stream.
 *
 * Mapping from the v1 event contract: the v1 message.part.updated
 * step-finish record becomes the v2 session.step.ended record, session records
 * keep coming from session.created, and agent attribution is tracked from
 * session.agent.selected events. Provider and model attribution are empty
 * strings in this port because the v2 usage events do not carry them; the
 * store schema tolerates the gap exactly like the v1 fallback did.
 *
 * Enablement is resolved per event through the event's location directory so
 * one shared server can host projects with analytics enabled and disabled.
 */
export async function setupAnalyticsV2(
  adapter: V2AdapterContext,
  dependencies: Partial<AnalyticsV2Dependencies> = {},
): Promise<V2Plugin.Cleanup | void> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const opencodeVersion = String(
    (adapter.ctx.app as { version?: unknown } | undefined)?.version ?? "unknown",
  );
  const sessionAgents = new Map<string, string>();
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

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of adapter.ctx.event.subscribe({ signal: controller.signal })) {
        await failSoft(async () => {
          const typed = event as {
            type: string;
            location?: { directory?: string };
            data?: Record<string, unknown>;
          };
          const directory = typed.location?.directory;
          if (!directory) return;

          if (typed.type === "session.agent.selected") {
            const sessionID = typed.data?.sessionID;
            const agent = typed.data?.agent;
            if (typeof sessionID === "string" && typeof agent === "string") {
              sessionAgents.set(sessionID, agent);
            }
            return;
          }

          const snapshot = await adapter.resolver.forDirectory(directory);
          if (!snapshot || !isVvocPluginEnabled(snapshot.config, "analytics")) return;

          if (typed.type === "session.created") {
            const sessionID = typed.data?.sessionID ?? typed.data?.id;
            if (typeof sessionID !== "string") return;
            await deps.append({
              kind: "session",
              ts: new Date().toISOString(),
              sessionID,
              projectID: directory,
              title: "",
            });
            return;
          }

          if (typed.type === "session.step.ended") {
            const data = typed.data as
              | {
                  sessionID?: string;
                  assistantMessageID?: string;
                  cost?: unknown;
                  tokens?: {
                    input?: unknown;
                    output?: unknown;
                    reasoning?: unknown;
                    cache?: { read?: unknown; write?: unknown };
                  };
                }
              | undefined;
            if (!data || typeof data.sessionID !== "string") return;
            const toCount = (value: unknown): number =>
              typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
            const record: UsageRecord = {
              kind: "usage",
              ts: new Date().toISOString(),
              projectID: directory,
              projectDirectory: directory,
              sessionID: data.sessionID,
              messageID: typeof data.assistantMessageID === "string" ? data.assistantMessageID : "",
              partID: "",
              providerID: "",
              modelID: "",
              agent: sessionAgents.get(data.sessionID) ?? "",
              tokens: {
                input: toCount(data.tokens?.input),
                output: toCount(data.tokens?.output),
                reasoning: toCount(data.tokens?.reasoning),
                cacheRead: toCount(data.tokens?.cache?.read),
                cacheWrite: toCount(data.tokens?.cache?.write),
              },
              cost: typeof data.cost === "number" && Number.isFinite(data.cost) ? data.cost : 0,
              vvocVersion: deps.vvocVersion,
              opencodeVersion,
            };
            await deps.append(record);
          }
        });
      }
    } catch (error) {
      // A non-iterable or failing event stream must never surface as an
      // unhandled rejection inside the host process.
      console.error(`[vvoc analytics] event stream failed: ${String(error)}`);
    }
  })();

  return () => controller.abort();
}
// END_BLOCK_SETUP_ANALYTICS_V2
