// FILE: src/tui.tsx
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Publish the default @osovv/vv-opencode/tui module containing the managed context inspector, analytics indicator, and branding footer.
//   SCOPE: Stable TUI package entrypoint and module identity only.
//   DEPENDS: [@opencode-ai/plugin/tui, @opencode-ai/plugin, src/tui/context/plugin.ts, src/tui/analytics/indicator.tsx, src/tui/branding/footer.tsx]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, M-TUI-ANALYTICS-INDICATOR, M-TUI-BRANDING-FOOTER, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: BARREL
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - OpenCode TUI plugin module registering /context, the analytics indicator, and the branding footer.
//   ContextTuiPlugin - Named TUI plugin factory for direct consumers and tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-19-cache-hit-rate-analytics - Registered the live cache indicator and vvoc version footer alongside /context.]
// END_CHANGE_SUMMARY

import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { ContextTuiPlugin } from "./tui/context/plugin.js";
import { registerAnalyticsIndicator } from "./tui/analytics/indicator.js";
import { registerBrandingFooter } from "./tui/branding/footer.js";

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
  },
};
// END_BLOCK_TUI_MODULE

export default plugin;
