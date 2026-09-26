// FILE: src/tui.tsx
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Publish the dual-runtime TUI entrypoint: the full v1 context inspector, analytics indicator, branding footer, and peak-hours banner through tui(), and the v2 CLI plugin registration for /context through setup().
//   SCOPE: Stable TUI package entrypoint and dual runtime identity only; feature registration stays in the focused modules.
//   DEPENDS: [@opencode-ai/plugin/tui, @opencode/plugin/tui, src/tui/context/plugin.ts, src/tui/analytics/indicator.tsx, src/tui/branding/footer.tsx, src/tui/peak-hours/banner.tsx]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, M-TUI-ANALYTICS-INDICATOR, M-TUI-BRANDING-FOOTER, M-TUI-PEAK-HOURS-BANNER, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: BARREL
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Dual TUI entrypoint: v2 setup() registers the /context command, v1 tui() registers the full inspector, indicator, footer, and banner.
//   ContextTuiPlugin - Named TUI plugin factory for direct consumers and tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-007 - Added the v2 CLI plugin setup registering /context beside the unchanged v1 TUI module.]
// END_CHANGE_SUMMARY

import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { ContextTuiPlugin } from "./tui/context/plugin.js";
import { registerAnalyticsIndicator } from "./tui/analytics/indicator.js";
import { registerBrandingFooter } from "./tui/branding/footer.js";
import { registerPeakHoursBanner } from "./tui/peak-hours/banner.js";

export { ContextTuiPlugin };

// START_BLOCK_TUI_MODULE
const plugin: TuiPluginModule & { id: string; setup?: (context: unknown) => Promise<void> | void } =
  {
    id: "vvoc-context",
    tui: async (api, options, meta) => {
      await ContextTuiPlugin(api, options, meta);
      try {
        await registerAnalyticsIndicator(api, options);
      } catch {
        // Fail-soft: indicator unavailable for this session.
      }
      try {
        registerBrandingFooter(api);
      } catch {
        // Fail-soft: footer unavailable for this session.
      }
      try {
        await registerPeakHoursBanner(api, options);
      } catch {
        // Fail-soft: banner unavailable for this session.
      }
    },
    // START_BLOCK_V2_TUI_SETUP
    // OpenCode v2 loads the same entrypoint through setup() with the CLI plugin
    // context. The v2 surface registers the /context slash command; the full
    // inspector components port onto the v2 dialog and router surfaces in a
    // follow-up release and this command keeps the entry point honest.
    async setup(context) {
      const ctx = context as {
        keymap: {
          layer: (layer: unknown) => unknown;
        };
        ui: {
          dialog: {
            alert: (input: { title: string; message: string }) => Promise<void>;
          };
        };
        data?: {
          location?: { default?: () => { directory?: string } | undefined };
        };
        app?: { version?: string };
      };
      try {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "vvoc.context",
              title: "vvoc context inspector",
              slash: { name: "context" },
              palette: true,
              run: async () => {
                const directory = ctx.data?.location?.default?.()?.directory ?? "unknown location";
                await ctx.ui.dialog.alert({
                  title: "vvoc /context",
                  message:
                    `OpenCode v2 runtime (host ${ctx.app?.version ?? "unknown"}).\n` +
                    `Location: ${directory}\n` +
                    "The full v2 context inspector ships in the next vvoc release; " +
                    "server-side analytics, model roles, and guidance stay active.",
                });
              },
            },
          ],
        }));
      } catch {
        // Fail-soft: the v2 TUI host may not expose keymap layers yet.
      }
    },
    // END_BLOCK_V2_TUI_SETUP
  };
// END_BLOCK_TUI_MODULE

export default plugin;
