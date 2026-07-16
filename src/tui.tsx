// FILE: src/tui.tsx
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Publish the default @osovv/vv-opencode/tui module containing the managed context inspector.
//   SCOPE: Stable TUI package entrypoint and module identity only.
//   DEPENDS: [@opencode-ai/plugin/tui, src/tui/context/plugin.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: BARREL
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - OpenCode TUI plugin module registering the /context inspector.
//   ContextTuiPlugin - Named TUI plugin factory for direct consumers and tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added the public TUI package subpath.]
// END_CHANGE_SUMMARY

import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { ContextTuiPlugin } from "./tui/context/plugin.js";

export { ContextTuiPlugin };

const plugin: TuiPluginModule & { id: string } = {
  id: "vvoc-context",
  tui: ContextTuiPlugin,
};

export default plugin;
