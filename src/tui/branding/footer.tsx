// FILE: src/tui/branding/footer.tsx
// VERSION: 1.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Show a combined OpenCode + vvoc version line in the OpenCode sidebar footer slot.
//   SCOPE: Version label composition, native-looking combined line rendering with theme colors, single_winner sidebar_footer ownership via explicit order, and fail-soft behavior.
//   DEPENDS: [@opencode-ai/plugin/tui, @opentui/solid, @opentui/core, src/lib/package.ts]
//   LINKS: [M-TUI-BRANDING-FOOTER, M-PLUGIN-ANALYTICS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   BrandingVersionInfo - OpenCode and vvoc version strings rendered by the footer.
//   BrandingColors - Theme RGBA colors used by the combined footer line.
//   BrandingDependencies - Injectable line renderer for focused tests.
//   brandingFooterLabel - The vvoc label text, e.g. "vvoc v1.2.11".
//   registerBrandingFooter - Registers the combined sidebar_footer version line.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-21-sidebar-footer-merge - Moved the label back into sidebar_footer as a combined OpenCode + vvoc version line that deliberately wins the single_winner slot, replacing the app_bottom registration.]
// END_CHANGE_SUMMARY

import type { JSX } from "@opentui/solid";
import type { RGBA } from "@opentui/core";
import type { TuiPluginApi, TuiSlotContext } from "@opencode-ai/plugin/tui";
import { getPackageVersionSync } from "../../lib/package.js";

export type BrandingVersionInfo = {
  opencodeVersion: string;
  vvocLabel: string;
};

export type BrandingColors = {
  muted: RGBA;
  success: RGBA;
  text: RGBA;
};

export type BrandingDependencies = {
  /** Renders the combined version line; defaults to the native-looking OpenCode footer line extended with the vvoc label. */
  renderLabel: (info: BrandingVersionInfo, colors: BrandingColors) => JSX.Element;
};

const DEFAULT_DEPENDENCIES: BrandingDependencies = {
  renderLabel: (info, colors) => (
    <text fg={colors.muted}>
      <span style={{ fg: colors.success }}>•</span> <b>Open</b>
      <span style={{ fg: colors.text }}>
        <b>Code</b>
      </span>{" "}
      <span>{info.opencodeVersion}</span>
      <span> · {info.vvocLabel}</span>
    </text>
  ),
};

/** The vvoc label text, e.g. "vvoc v1.2.11". */
export function brandingFooterLabel(): string {
  return `vvoc v${getPackageVersionSync()}`;
}

// START_BLOCK_REGISTER_BRANDING_FOOTER
/**
 * Registers the combined version line in the "sidebar_footer" host slot.
 *
 * sidebar_footer renders in single_winner mode: only the first registered
 * plugin (lowest order) is displayed. OpenCode's internal footer registers
 * with order 100; this plugin uses order 50 so it deterministically wins the
 * slot and renders the stock-looking footer line extended with the vvoc
 * version ("• OpenCode <oc> · vvoc v<x>"). Always on (independent of analytics
 * config); returns silently when the slot API is unavailable or registration
 * fails.
 */
export function registerBrandingFooter(
  api: TuiPluginApi,
  dependencies: BrandingDependencies = DEFAULT_DEPENDENCIES,
): void {
  if (typeof api.slots?.register !== "function") return;
  try {
    // OpenCode's runtime requires a string plugin id on slot registrations, while
    // the SDK's TuiSlotPlugin type still types id as never; cast bridges the two.
    const plugin = {
      id: "vvoc-branding",
      order: 50,
      slots: {
        sidebar_footer: (ctx: TuiSlotContext) => {
          const theme = ctx.theme.current;
          return dependencies.renderLabel(
            { opencodeVersion: api.app.version, vvocLabel: brandingFooterLabel() },
            { muted: theme.textMuted, success: theme.success, text: theme.text },
          );
        },
      },
    } as unknown as Parameters<TuiPluginApi["slots"]["register"]>[0];
    api.slots.register(plugin);
  } catch {
    // Fail-soft: no combined footer for this session.
  }
}
// END_BLOCK_REGISTER_BRANDING_FOOTER
