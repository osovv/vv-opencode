// FILE: scripts/vite-gui.ts
// VERSION: 1.0.0
import { defineConfig } from "vite";
import { gui } from "@opencode/plugin/gui/vite";

// START_MODULE_CONTRACT
//   PURPOSE: Build the `./gui-experimental` window part with the host-provided Vite GUI preset: one CommonJS bundle from the `src/gui-experimental.tsx` entry at `dist/gui-experimental.cjs`, app-provided modules external, dynamic imports inlined.
//   SCOPE: Vite build configuration only; no server behavior, no packaging beyond the bundle the preset writes.
//   DEPENDS: [vite, @opencode/plugin/gui/vite]
//   LINKS: [M-GUI-SPIKE, V-M-PLUGIN-GUI-SETTINGS]
//   ROLE: CONFIG
//   MAP_MODE: NONE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [GUI-SPike initial skeleton - Added the preset-driven Vite config for the experimental GUI bundle, explicitly not named vite.config.ts because the oxlint/oxfmt gates auto-discover root TS configs.]
// END_CHANGE_SUMMARY

// Run explicitly: `vite build --config scripts/vite-gui.ts`.
export default defineConfig({
  plugins: [gui({ entry: "src/gui-experimental.tsx" })],
});