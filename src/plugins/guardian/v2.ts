// FILE: src/plugins/guardian/v2.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Review OpenCode v2 permission requests with the constrained Guardian agent through a v1-shaped client shim over the v2 plugin domains.
//   SCOPE: v2 setup only: subscribe to permission.asked and permission.replied events, track tool intents on the execute.before hook, adapt the four client surfaces the shared review flow needs (logging, toast no-op, session transcript, permission reply) onto v2 domains, and keep the nested-review auto-deny and cancellation semantics unchanged.
//   DEPENDS: [@opencode/plugin, src/lib/config-layers.ts, src/lib/managed-agents.ts, src/plugins/guardian/index.ts, src/plugins/v2-runtime/setup.ts]
//   LINKS: [M-PLUGIN-GUARDIAN, V-M-PLUGIN-GUARDIAN, M-PLUGIN-V2-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   setupGuardianV2 - Register the permission review flow for one OpenCode v2 plugin context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-003 - Ported the Guardian permission review onto v2 events and domains through a client shim.]
// END_CHANGE_SUMMARY

import type { Plugin as V2Plugin } from "@opencode/plugin";
import type { V2AdapterContext } from "../v2-runtime/setup.js";
import { loadVvocConfigForRead } from "../../lib/config-layers.js";
import { loadManagedAgentPromptText } from "../../lib/managed-agents.js";
import {
  GUARDIAN_AGENT,
  GUARDIAN_DISABLED_ENV,
  reviewPermissionRequest,
  resolveGuardianRuntimeConfig,
} from "./index.js";
import type { VvocConfigSnapshot } from "../../lib/config-layers.js";

// START_BLOCK_GUARDIAN_V2_CLIENT_SHIM
/**
 * A v1-shaped client built on v2 domains, providing exactly the four
 * surfaces the shared review flow consumes. Toasts degrade to a no-op
 * because v2 server plugins have no TUI channel; the TUI banner surface
 * belongs to the CLI plugin.
 */
function createClientShim(adapter: V2AdapterContext, directory: string) {
  return {
    app: {
      log: async () => {},
    },
    tui: {
      show: async () => {},
    },
    session: {
      messages: async (input: { path: { id: string } }) => {
        try {
          const data = await adapter.ctx.session.context({ sessionID: input.path.id });
          return { data };
        } catch (error) {
          return { data: undefined, error };
        }
      },
    },
    permission: {
      reply: async (input: {
        requestID: string;
        reply: "once" | "always" | "reject";
        message?: string;
      }) => {
        await adapter.ctx.permission.reply({
          requestID: input.requestID,
          decision: input.reply,
          message: input.message,
        } as never);
        return { data: true };
      },
    },
    directory,
  };
}
// END_BLOCK_GUARDIAN_V2_CLIENT_SHIM

// START_BLOCK_SETUP_GUARDIAN_V2
/**
 * Register the Guardian review flow on the v2 runtime.
 *
 * The v2 permission.asked and permission.replied events carry the same
 * request fields the v1 events did, so the review flow itself is reused
 * unchanged through the client shim. Tool intents keep flowing from the
 * execute.before hook; the guardian agent definition itself comes from the
 * managed agent files vvoc sync installs, replacing the v1 runtime config
 * hook installation.
 */
export async function setupGuardianV2(adapter: V2AdapterContext): Promise<V2Plugin.Cleanup | void> {
  const directory = adapter.ctx.location.directory;
  const read = await loadVvocConfigForRead({
    cwd: directory,
    scope: "effective",
    allowDefault: true,
  });
  const vvoc: VvocConfigSnapshot = {
    config: read.config,
    source: read.source,
    warnings: read.warnings,
    loadedAt: new Date().toISOString(),
  };

  const { isVvocPluginEnabled } = await import("../../lib/plugin-toggle-config.js");
  if (!isVvocPluginEnabled(read.config, "guardian")) return undefined;

  if (process.env[GUARDIAN_DISABLED_ENV] === "1") {
    // Nested reviews must never grant permissions: auto-deny stays active.
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of adapter.ctx.event.subscribe({ signal: controller.signal })) {
          const typed = event as { type?: string; data?: { id?: string; sessionID?: string } };
          if (typed.type !== "permission.asked" || !typed.data?.id || !typed.data.sessionID)
            continue;
          try {
            await adapter.ctx.permission.reply({
              requestID: typed.data.id,
              decision: "reject",
              message: "Guardian nested reviews do not allow additional permissions.",
            } as never);
          } catch {
            // Nested deny is best-effort.
          }
        }
      } catch {
        // Stream failures never break the host.
      }
    })();
    return async () => {
      controller.abort();
      for (const dispose of cleanups.reverse()) await dispose();
    };
  }

  const guardianConfig = resolveGuardianRuntimeConfig(vvoc);
  const guardianPrompt = await loadManagedAgentPromptText(directory, GUARDIAN_AGENT as never);
  const client = createClientShim(adapter, directory);
  const dummyUrl = new URL("http://127.0.0.1:1");

  const toolIntentsByCallID = new Map<string, unknown>();
  const latestCommandIntentBySessionID = new Map<string, unknown>();
  const activeReviews = new Map<
    string,
    {
      cancelled: boolean;
      internalReply: boolean;
      cancellationNoticeShown?: boolean;
      cancel?: () => void;
    }
  >();
  const cleanups: Array<() => Promise<void>> = [];

  // START_BLOCK_GUARDIAN_V2_INTENTS
  // Tool intents: the v1 tool.execute.before tracker keeps review context
  // about the call that triggered each permission request; without it the
  // review prompt loses the planned-action context. A bounded clear replaces
  // the v1 prune to keep the map from growing unbounded.
  const intentHook = await adapter.ctx.tool.hook("execute.before", (event) => {
    const intents = toolIntentsByCallID as Map<
      string,
      { sessionID: string; tool: string; callID: string; args: unknown; time: number }
    >;
    if (intents.size > 500) intents.clear();
    intents.set(String(event.id), {
      sessionID: String(event.sessionID),
      tool: String(event.tool),
      callID: String(event.id),
      args: event.input,
      time: Date.now(),
    });
  });
  cleanups.push(() => intentHook.dispose());

  // Best-effort command intents: v2 has no global command interception hook;
  // prompt admission metadata carries command identity when the host sets it.
  const promptHook = await adapter.ctx.session.hook("prompt", (event) => {
    const metadata = (event as { metadata?: Record<string, unknown> }).metadata ?? {};
    const command = metadata.command ?? metadata.name;
    if (typeof command !== "string" || !command) return;
    const commands = latestCommandIntentBySessionID as Map<
      string,
      { sessionID: string; command: string; arguments: string; time: number }
    >;
    commands.set(String(event.sessionID), {
      sessionID: String(event.sessionID),
      command,
      arguments: typeof metadata.arguments === "string" ? metadata.arguments : "",
      time: Date.now(),
    });
  });
  cleanups.push(() => promptHook.dispose());
  // END_BLOCK_GUARDIAN_V2_INTENTS

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of adapter.ctx.event.subscribe({ signal: controller.signal })) {
        const located = event as { location?: { directory?: string } };
        if (located.location?.directory && located.location.directory !== directory) continue;
        const typed = event as {
          type?: string;
          data?: Record<string, unknown> & { id?: string; sessionID?: string; requestID?: string };
        };
        if (
          typed.type === "permission.asked" &&
          typed.data?.id &&
          !activeReviews.has(typed.data.id)
        ) {
          const activeReview = {
            cancelled: false,
            internalReply: false,
            cancellationNoticeShown: false,
          };
          activeReviews.set(typed.data.id, activeReview);
          void reviewPermissionRequest(
            client as never,
            dummyUrl,
            directory,
            guardianPrompt,
            guardianConfig,
            typed.data as never,
            toolIntentsByCallID as never,
            latestCommandIntentBySessionID as never,
            activeReviews as never,
            activeReview as never,
          ).catch((error) => {
            console.error(`[vvoc][guardian] review failed: ${String(error)}`);
          });
          continue;
        }
        if (typed.type === "permission.replied") {
          const permissionID = typed.data?.requestID;
          if (typeof permissionID !== "string") continue;
          const activeReview = activeReviews.get(permissionID);
          if (!activeReview || activeReview.internalReply) continue;
          activeReview.cancelled = true;
          activeReview.cancel?.();
        }
      }
    } catch (error) {
      console.error(`[vvoc][guardian] event stream failed: ${String(error)}`);
    }
  })();

  return () => controller.abort();
}
// END_BLOCK_SETUP_GUARDIAN_V2
