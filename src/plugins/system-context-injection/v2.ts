// FILE: src/plugins/system-context-injection/v2.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Inject the vvoc system guidance into OpenCode v2 model requests with per-session location resolution and agent filtering.
//   SCOPE: v2 setup only: register the session context hook, resolve the injection policy from the session's effective config, skip known subagents and internal request kinds, and append the same system context blocks the v1 chat.message hook produced; v1 config-hook skills-path registration moves to vvoc sync config writes under v2.
//   DEPENDS: [@opencode/plugin, src/lib/orchestration.ts, src/plugins/system-context-injection/index.ts, src/plugins/v2-runtime/setup.ts]
//   LINKS: [M-PLUGIN-SYSTEM-CONTEXT-INJECTION, V-M-PLUGIN-SYSTEM-CONTEXT-INJECTION, M-PLUGIN-V2-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   setupSystemContextInjectionV2 - Register the per-request system context injection hook for one OpenCode v2 plugin context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-004 - Ported system guidance injection onto the v2 session context hook.]
// END_CHANGE_SUMMARY

import type { Plugin as V2Plugin } from "@opencode/plugin";
import type { V2AdapterContext } from "../v2-runtime/setup.js";
import { resolveOrchestrationPolicy } from "../../lib/orchestration.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import {
  createKnownSubagentSet,
  getSystemContextsForAgent,
  shouldInjectForAgent,
} from "./agent-contexts.js";

// START_BLOCK_SETUP_SYSTEM_CONTEXT_INJECTION_V2
/**
 * Register the system-context injection hook on the v2 runtime.
 *
 * The v1 chat.message mutation of output.message.system becomes the v2
 * session context hook appending text SystemParts to event.system, which runs
 * immediately before each agent-loop model request and therefore covers tool
 * continuations as well. Enablement and policy resolve per session through
 * the shared location resolver so one server can host projects with different
 * orchestration policies.
 */
export async function setupSystemContextInjectionV2(
  adapter: V2AdapterContext,
): Promise<V2Plugin.Cleanup | void> {
  const knownSubagents = createKnownSubagentSet();
  const registration = await adapter.ctx.session.hook("context", async (event) => {
    try {
      const snapshot = await adapter.resolver.forSession(event.sessionID as string, (input) =>
        adapter.ctx.session.get(input),
      );
      if (!snapshot || !isVvocPluginEnabled(snapshot.config, "system-context-injection")) {
        return;
      }

      if (!shouldInjectForAgent(event.agent as string | undefined, knownSubagents)) {
        return;
      }

      const policy = resolveOrchestrationPolicy(snapshot.config);
      const contexts = getSystemContextsForAgent(event.agent as string | undefined, policy);
      for (const context of contexts) {
        const alreadyInjected = event.system.some(
          (part) =>
            part.type === "text" && typeof part.text === "string" && part.text.includes(context),
        );
        if (!alreadyInjected) {
          event.system.push({ type: "text", text: context });
        }
      }
    } catch (error) {
      console.warn(`[vvoc][system-context-injection] context hook failed: ${String(error)}`);
    }
  });

  return () => registration.dispose();
}
// END_BLOCK_SETUP_SYSTEM_CONTEXT_INJECTION_V2
