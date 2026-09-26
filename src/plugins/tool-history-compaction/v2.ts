// FILE: src/plugins/tool-history-compaction/v2.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Register tool-history compaction on the OpenCode v2 session context hook with per-session location resolution.
//   SCOPE: v2 setup only: gate on the per-location plugin toggle, rewrite only the in-memory message copy the model is about to receive through the shared pure compactMessages transform, and stay fail-soft on handler errors.
//   DEPENDS: [@opencode/plugin, src/lib/config-layers.ts, src/plugins/tool-history-compaction/config.ts, src/plugins/tool-history-compaction/transform.ts, src/plugins/v2-runtime/setup.ts]
//   LINKS: [M-PLUGIN-TOOL-HISTORY-COMPACTION, V-M-PLUGIN-TOOL-HISTORY-COMPACTION, M-PLUGIN-V2-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   setupToolHistoryCompactionV2 - Register the compaction context hook for one OpenCode v2 plugin context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-004 - Ported tool-history compaction onto the v2 session context hook.]
// END_CHANGE_SUMMARY

import type { Plugin as V2Plugin } from "@opencode/plugin";
import type { V2AdapterContext } from "../v2-runtime/setup.js";
import { parseToolHistoryCompactionEntry } from "./config.js";
import { compactMessages, type TransformMessage } from "./transform.js";

// START_BLOCK_SETUP_TOOL_HISTORY_COMPACTION_V2
/**
 * Register the compaction hook on the v2 runtime.
 *
 * The v1 experimental.chat.messages.transform becomes the v2 session context
 * hook, which owns the mutable message copy for the outgoing model request.
 * Enablement resolves per session location so one shared server can host
 * projects with different compaction settings.
 */
export async function setupToolHistoryCompactionV2(
  adapter: V2AdapterContext,
): Promise<V2Plugin.Cleanup | void> {
  const registration = await adapter.ctx.session.hook("context", async (event) => {
    try {
      const snapshot = await adapter.resolver.forSession(event.sessionID as string, (input) =>
        adapter.ctx.session.get(input),
      );
      if (!snapshot) return;
      const entry = parseToolHistoryCompactionEntry(
        (snapshot.config.plugins as Record<string, unknown> | undefined)?.[
          "tool-history-compaction"
        ],
      );
      if (!entry.enabled) return;

      const messages = event.messages as unknown as Array<{
        parts?: Array<Record<string, unknown>>;
      }>;
      const adapted: TransformMessage[] = messages.map((message) => ({
        info: message,
        parts: (message.parts ?? []) as TransformMessage["parts"],
      }));
      compactMessages(adapted, entry.config);
      for (const [index, message] of messages.entries()) {
        message.parts = adapted[index]?.parts as unknown as typeof message.parts;
      }
    } catch (error) {
      console.warn(`[vvoc][tool-history-compaction] context hook failed: ${String(error)}`);
    }
  });

  return () => registration.dispose();
}
// END_BLOCK_SETUP_TOOL_HISTORY_COMPACTION_V2
