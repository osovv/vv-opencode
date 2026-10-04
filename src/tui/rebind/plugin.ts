// FILE: src/tui/rebind/plugin.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Register the native OpenCode /vv-rebind slash command that rebinds the current session family to the current effective vvoc configuration on its next workload.
//   SCOPE: Keymap command registration through the native app slot, active-session gating, one bounded toast per outcome, and a single atomic rebind-marker write through the shared writer with lifecycle disposal. No configuration parsing, no credential values, and no other filesystem access.
//   DEPENDS: [@opencode/plugin/tui, src/lib/rebind-request.ts, src/tui/context/plugin.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, M-NATIVE-RUNTIME, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   REBIND_COMMAND_ID - Stable native keymap command id behind /vv-rebind.
//   RebindTuiDependencies - Injectable marker writer and working-directory resolver for focused tests.
//   registerRebindTuiCommand - Register /vv-rebind on the native keymap layer.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-VV-REBIND-TUI-COMMAND T-001 - Added /vv-rebind as a thin TUI facade over the existing rebind request marker consumed on the family's next workload.]
// END_CHANGE_SUMMARY

import type { Plugin } from "@opencode/plugin/tui";
import { writeRebindRequest, type RebindRequest } from "../../lib/rebind-request.js";
import { activeSessionID } from "../context/plugin.js";

/** Stable native keymap command id behind the /vv-rebind slash command. */
export const REBIND_COMMAND_ID = "vvoc.rebind.request";

/** Injectable marker writer and working-directory resolver for focused tests. */
export type RebindTuiDependencies = {
  readonly writeMarker: (input: {
    readonly directory: string;
    readonly sessionId: string;
  }) => Promise<RebindRequest>;
  readonly directory: () => string;
};

/**
 * Register /vv-rebind on the native keymap layer, mirroring the /context
 * registration: the layer must be created inside a mounted slot render, so the
 * command claims the always-present `app` slot. Running the command with an
 * open session writes exactly one project-scoped rebind request marker naming
 * the active session; the existing lazy consumer applies it on the family's
 * next workload. The command reads nothing else and displays no configuration
 * content, so a rebind is safe to request from any session state.
 */
export function registerRebindTuiCommand(
  ctx: Plugin.Context,
  dependencies: RebindTuiDependencies = {
    writeMarker: writeRebindRequest,
    directory: () => process.cwd(),
  },
): () => void {
  return ctx.ui.slot({
    append: "app",
    render() {
      ctx.keymap.layer(() => ({
        // Global so the command stays reachable from the prompt input mode,
        // like /context; the default base layer is not.
        mode: "global",
        commands: [
          {
            id: REBIND_COMMAND_ID,
            title: "Rebind session policy",
            description:
              "Re-resolve the vvoc configuration for this session family from the next message",
            group: "VVOC",
            palette: true,
            slash: { name: "vv-rebind" },
            enabled: () => activeSessionID(ctx) !== undefined,
            run: async () => {
              const sessionID = activeSessionID(ctx);
              if (sessionID === undefined) {
                // Reachable only through the palette when no session is open.
                ctx.ui.toast.show({
                  variant: "warning",
                  title: "Rebind session",
                  message: "Open a session before running /vv-rebind.",
                });
                return;
              }
              try {
                await dependencies.writeMarker({
                  directory: dependencies.directory(),
                  sessionId: sessionID,
                });
                // A user who switched tabs mid-write did not see the outcome.
                if (activeSessionID(ctx) !== sessionID) return;
                ctx.ui.toast.show({
                  variant: "success",
                  title: "Rebind session",
                  message: "Re-resolving the configuration from the next message.",
                });
              } catch (error) {
                if (activeSessionID(ctx) !== sessionID) return;
                ctx.ui.toast.show({
                  variant: "error",
                  title: "Rebind unavailable",
                  message: boundedError(error),
                });
              }
            },
          },
        ],
      }));
      // The slot exists only to host the keymap layer; it renders nothing.
      return null;
    },
  });
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 180 ? `${message.slice(0, 177)}...` : message;
}
