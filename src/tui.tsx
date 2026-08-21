// FILE: src/tui.tsx
// VERSION: 1.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Publish the default @osovv/vv-opencode/tui module containing the managed context inspector, analytics indicator, branding footer, and peak-hours banner.
//   SCOPE: Stable TUI package entrypoint and module identity only.
//   DEPENDS: [@opencode-ai/plugin/tui, @opencode-ai/plugin, src/tui/context/plugin.ts, src/tui/analytics/indicator.tsx, src/tui/branding/footer.tsx, src/tui/peak-hours/banner.tsx]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, M-TUI-ANALYTICS-INDICATOR, M-TUI-BRANDING-FOOTER, M-TUI-PEAK-HOURS-BANNER, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: BARREL
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - OpenCode TUI plugin module registering /context, the analytics indicator, the branding footer, and the peak-hours banner.
//   ContextTuiPlugin - Named TUI plugin factory for direct consumers and tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-PLUGIN-PEAK-HOURS - Registered the app_bottom peak-hours banner alongside the indicator and footer.]
// END_CHANGE_SUMMARY

import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { ContextTuiPlugin } from "./tui/context/plugin.js";
import { registerAnalyticsIndicator } from "./tui/analytics/indicator.js";
import { registerBrandingFooter } from "./tui/branding/footer.js";
import { registerPeakHoursBanner } from "./tui/peak-hours/banner.js";

export { ContextTuiPlugin };

// START_BLOCK_TUI_MODULE
const plugin: TuiPluginModule & { id: string } = {
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
};
// END_BLOCK_TUI_MODULE

export default plugin;
