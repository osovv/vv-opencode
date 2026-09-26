// FILE: src/plugins/peak-hours/v2.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Block peak-priced provider requests on the OpenCode v2 runtime with dynamic off-peak suggestions and session-age plus subagent grace.
//   SCOPE: v2 setup only: gate the session context hook on the per-location peak-hours entry, apply internal-agent and known-subagent exemptions plus persisted-session grace, compose the identical hard-block message from the shared pure schedule library, enumerate connected providers through the v2 provider domain, and degrade fail-open on any resolution error.
//   DEPENDS: [@opencode/plugin, src/lib/peak-hours.ts, src/plugins/peak-hours/index.ts, src/plugins/v2-runtime/setup.ts]
//   LINKS: [M-PLUGIN-PEAK-HOURS, V-M-PLUGIN-PEAK-HOURS, M-PEAK-HOURS-SCHEDULES, M-PLUGIN-V2-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   setupPeakHoursV2 - Register the peak-hours hard-block context hook for one OpenCode v2 plugin context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-003 - Ported peak-hours hard blocking onto the v2 session context hook.]
// END_CHANGE_SUMMARY

import type { Plugin as V2Plugin } from "@opencode/plugin";
import type { V2AdapterContext } from "../v2-runtime/setup.js";
import {
  findActivePeak,
  formatPeakEndTime,
  normalizeProviderId,
  parsePeakHoursEntry,
  suggestOffPeakProviders,
} from "../../lib/peak-hours.js";
import { buildHardBlockMessage, createKnownSubagentSet } from "./index.js";

// START_BLOCK_SETUP_PEAK_HOURS_V2
/**
 * Register the peak-hours hook on the v2 runtime.
 *
 * The v1 chat.params post-persist throw becomes the v2 session context hook:
 * the prompt is already admitted, so throwing fails the outgoing model call
 * and surfaces the block as the request error, preserving the v1 semantics.
 * The peak decision reuses the shared pure schedule library with the same
 * internal-agent, subagent, parent-session, and session-age grace rules.
 */
export async function setupPeakHoursV2(
  adapter: V2AdapterContext,
): Promise<V2Plugin.Cleanup | void> {
  // Static managed-subagent set: these agents are continuation of already
  // admitted work and always soften. Config-defined subagents cannot be
  // discovered through the v2 plugin-host registry (probe-verified split),
  // so the managed names plus built-ins carry the exemption.
  const knownSubagents = createKnownSubagentSet();
  const registration = await adapter.ctx.session.hook("context", async (event) => {
    try {
      const providerID = (event.model as { providerID?: string } | undefined)?.providerID;
      if (!providerID) return;
      const agent = event.agent as string | undefined;
      if (agent === "compaction" || agent === "title" || agent === "summary") return;

      const snapshot = await adapter.resolver.forSession(event.sessionID as string, (input) =>
        adapter.ctx.session.get(input),
      );
      if (!snapshot) return;
      const { entry } = parsePeakHoursEntry(
        (snapshot.config.plugins as Record<string, unknown> | undefined)?.["peak-hours"],
      );
      if (!entry.enabled) return;

      const now = new Date();
      const peak = findActivePeak(now, entry.schedules, providerID);
      if (!peak) return;

      const override = entry.schedules[peak.providerKey]?.mode;
      let mode = override ?? entry.mode;
      if (agent && knownSubagents.has(agent)) mode = "soft";

      if (mode === "hard") {
        const session = (await adapter.ctx.session
          .get({ sessionID: event.sessionID as string })
          .catch(() => undefined)) as
          | { parentID?: unknown; time?: { created?: unknown } }
          | undefined;
        if (!session) {
          mode = "soft";
        } else {
          const parentID = (session as { parentID?: unknown }).parentID;
          if (typeof parentID === "string" && parentID) mode = "soft";
          const created = session.time?.created;
          if (
            entry.graceActiveSessions &&
            (typeof created === "number" || typeof created === "string") &&
            new Date(created).getTime() < peak.startedAt.getTime()
          ) {
            mode = "soft";
          }
        }
      }

      if (mode !== "hard") return;

      const providersResponse = (await adapter.ctx.provider.list().catch(() => undefined)) as
        | { data?: Array<{ id?: unknown }> }
        | undefined;
      const connected = (providersResponse?.data ?? [])
        .map((provider) => (typeof provider.id === "string" ? provider.id : ""))
        .filter(Boolean);
      const suggestions = suggestOffPeakProviders(now, entry.schedules, connected).filter(
        (candidate) => normalizeProviderId(candidate) !== normalizeProviderId(providerID),
      );
      const message = buildHardBlockMessage(providerID, peak, suggestions);
      console.log(
        `[peak-hours] hard block applied: provider=${providerID} until=${formatPeakEndTime(peak.endsAt)} session=${String(event.sessionID)}`,
      );
      throw new Error(message);
    } catch (error) {
      if (error instanceof Error && error.message.includes("peak")) {
        throw error;
      }
      console.warn(`[vvoc][peak-hours] context hook failed open: ${String(error)}`);
    }
  });

  return () => registration.dispose();
}
// END_BLOCK_SETUP_PEAK_HOURS_V2
