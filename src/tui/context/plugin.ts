// FILE: src/tui/context/plugin.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Register the native OpenCode /context slash command and connect the shared policy gate, native collection, and tabbed dialog rendering.
//   SCOPE: Policy-gated command registration through the native keymap layer, active-session gating, bounded error toasts, and lifecycle disposal. It performs no local filesystem config read.
//   DEPENDS: [@opencode/plugin/tui, src/tui/context/types.ts, src/tui/context/view.tsx]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, DF-CONTEXT-INSPECTION, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ContextTuiDependencies - Injectable enablement, revalidation, collection, and rendering dependencies for focused tests.
//   registerContextTuiPlugin - Register /context with injectable dependencies for focused tests.
//   activeSessionID - Current session id from the native router, or undefined.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 attempt 2 - Revalidated the captured policy before running, honored explicit disable, and dropped collection results whose tab changed mid-flight.]
// END_CHANGE_SUMMARY

import type { Plugin } from "@opencode/plugin/tui";
import type { ContextAnalysis } from "./types.js";
import { claimContextCommand } from "./view.js";

const CONTEXT_COMMAND = "vvoc.context.show";

export type ContextTuiDependencies = {
  /** Shared policy gate: true only when the context plugin is enabled. */
  isEnabled: () => boolean;
  /**
   * Revalidate the selected session's captured policy before running. Returns
   * false when the captured policy explicitly disables the context plugin.
   */
  revalidate: (ctx: Plugin.Context, sessionID: string) => Promise<boolean>;
  collect: (ctx: Plugin.Context, sessionID: string) => Promise<ContextAnalysis>;
  open: (ctx: Plugin.Context, analysis: ContextAnalysis) => void;
};
// START_BLOCK_CONTEXT_COMMAND_REGISTRATION
/**
 * Register /context on the native keymap layer. The layer must be created from
 * inside a mounted slot render (where the native Keymap provider context
 * exists), so this claims the always-present `app` slot and registers the
 * palette/slash command there. The command is enabled only for an open session
 * while the shared policy allows it, and renders through the native host dialog
 * on success or a bounded error toast on failure.
 */
export function registerContextTuiPlugin(
  ctx: Plugin.Context,
  options: Readonly<Record<string, unknown>> | undefined,
  dependencies: ContextTuiDependencies,
): () => void {
  if (options?.enabled === false) return () => undefined;

  return claimContextCommand(ctx, {
    id: CONTEXT_COMMAND,
    isEnabled: () => dependencies.isEnabled() && activeSessionID(ctx) !== undefined,
    run: async () => {
      const sessionID = activeSessionID(ctx);
      if (sessionID === undefined) {
        ctx.ui.toast.show({
          variant: "warning",
          title: "Context usage",
          message: "Open a session before running /context.",
        });
        return;
      }
      try {
        // The command stays reachable while the captured policy is unknown; an
        // explicit disabled capture suppresses it here.
        if (!(await dependencies.revalidate(ctx, sessionID))) {
          ctx.ui.toast.show({
            variant: "warning",
            title: "Context usage",
            message: "The /context plugin is disabled by the captured session policy.",
          });
          return;
        }
        if (activeSessionID(ctx) !== sessionID) return;
        const analysis = await dependencies.collect(ctx, sessionID);
        // A collection that finished after the user switched tabs must not open.
        if (activeSessionID(ctx) !== sessionID) return;
        dependencies.open(ctx, analysis);
      } catch (error) {
        ctx.ui.toast.show({
          variant: "error",
          title: "Context usage unavailable",
          message: boundedError(error),
        });
      }
    },
  });
}
// END_BLOCK_CONTEXT_COMMAND_REGISTRATION

/** Current session id from the native router, or undefined. */
export function activeSessionID(ctx: Plugin.Context): string | undefined {
  const route = ctx.ui.router.current();
  return route.type === "session" ? route.sessionID : undefined;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 180 ? `${message.slice(0, 177)}...` : message;
}
