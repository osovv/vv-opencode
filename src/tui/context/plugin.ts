// FILE: src/tui/context/plugin.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Register the modern OpenCode /context TUI command and connect config toggles, collection, and rendering.
//   SCOPE: Plugin enablement, active-session gating, keymap command registration, lifecycle cleanup, and bounded error toasts.
//   DEPENDS: [@opencode-ai/plugin/tui, src/lib/config-layers.ts, src/lib/plugin-toggle-config.ts, src/tui/context/collect.ts, src/tui/context/view.tsx]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, M-CONFIG-LAYERS, M-PLUGIN-TOGGLE-CONFIG, DF-CONTEXT-INSPECTION, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: INTEGRATION
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   registerContextTuiPlugin - Register /context with injectable dependencies for focused tests.
//   ContextTuiPlugin - Default production TUI plugin factory.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added modern slash command registration and fail-soft dialog execution.]
// END_CHANGE_SUMMARY

import type { PluginOptions } from "@opencode-ai/plugin";
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui";
import { loadVvocConfigForRead } from "../../lib/config-layers.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import { collectContextAnalysis } from "./collect.js";
import type { ContextAnalysis } from "./types.js";
import { openContextDialog } from "./view.js";

const CONTEXT_COMMAND = "vvoc.context.show";

export type ContextTuiDependencies = {
  enabled: (api: TuiPluginApi) => Promise<boolean>;
  collect: (api: TuiPluginApi, sessionID: string) => Promise<ContextAnalysis>;
  open: (api: TuiPluginApi, analysis: ContextAnalysis) => void;
};

const DEFAULT_DEPENDENCIES: ContextTuiDependencies = {
  enabled: async (api) => {
    const vvoc = await loadVvocConfigForRead({
      scope: "effective",
      allowDefault: true,
      cwd: api.state.path.directory,
    });
    return isVvocPluginEnabled(vvoc.config, "context");
  },
  collect: collectContextAnalysis,
  open: openContextDialog,
};

// START_BLOCK_CONTEXT_COMMAND_REGISTRATION
export async function registerContextTuiPlugin(
  api: TuiPluginApi,
  options: PluginOptions | undefined,
  dependencies: ContextTuiDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  if (options?.enabled === false || !(await dependencies.enabled(api))) return;

  const unregister = api.keymap.registerLayer({
    commands: [
      {
        name: CONTEXT_COMMAND,
        title: "Context usage",
        description: "Show measured context usage and an approximate source breakdown",
        category: "VVOC",
        namespace: "palette",
        slashName: "context",
        enabled: () => api.route.current.name === "session",
        async run() {
          const route = api.route.current;
          const sessionID =
            route.name === "session" &&
            "params" in route &&
            typeof route.params?.sessionID === "string"
              ? route.params.sessionID
              : undefined;
          if (!sessionID) {
            api.ui.toast({
              variant: "warning",
              title: "Context usage",
              message: "Open a session before running /context.",
            });
            return;
          }

          try {
            const analysis = await dependencies.collect(api, sessionID);
            dependencies.open(api, analysis);
          } catch (error) {
            api.ui.toast({
              variant: "error",
              title: "Context usage unavailable",
              message: boundedError(error),
            });
          }
        },
      },
    ],
  });
  api.lifecycle.onDispose(unregister);
}
// END_BLOCK_CONTEXT_COMMAND_REGISTRATION

export const ContextTuiPlugin: TuiPlugin = async (api, options) => {
  await registerContextTuiPlugin(api, options);
};

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 180 ? `${message.slice(0, 177)}...` : message;
}
