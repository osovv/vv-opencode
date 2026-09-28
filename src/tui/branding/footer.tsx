// FILE: src/tui/branding/footer.tsx
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Show a combined OpenCode + vvoc version line in the native sidebar footer slot.
//   SCOPE: Version label composition, theme-colored combined line rendering, native `sidebar.footer` claim via replace, and fail-soft behavior with a disposer.
//   DEPENDS: [@opencode/plugin/tui, @opentui/core, src/lib/package.ts]
//   LINKS: [M-TUI-BRANDING-FOOTER, M-PLUGIN-CONTEXT-TUI]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   BrandingVersionInfo - OpenCode and vvoc version strings rendered by the footer.
//   BrandingColors - Theme colors used by the combined footer line.
//   BrandingDependencies - Injectable line renderer for focused tests.
//   brandingFooterLabel - The vvoc label text, e.g. "vvoc v1.7.0".
//   registerBrandingFooter - Claim the native sidebar footer slot and return its disposer.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 - Ported the footer to the native sidebar.footer slot claim and native theme tokens.]
// END_CHANGE_SUMMARY

import type { JSX } from "@opentui/solid";
import type { RGBA } from "@opentui/core";
import type { Plugin } from "@opencode/plugin/tui";
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
  /** Renders the combined version line; defaults to the native-looking footer line extended with the vvoc label. */
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

/** The vvoc label text, e.g. "vvoc v1.7.0". */
export function brandingFooterLabel(): string {
  return `vvoc v${getPackageVersionSync()}`;
}

// START_BLOCK_REGISTER_BRANDING_FOOTER
/**
 * Claim the native `sidebar.footer` slot and render the stock-looking footer
 * line extended with the vvoc version. Always on (independent of analytics
 * config); returns a no-op when the slot API is unavailable or registration
 * fails.
 */
export function registerBrandingFooter(
  ctx: Plugin.Context,
  dependencies: BrandingDependencies = DEFAULT_DEPENDENCIES,
): () => void {
  try {
    return ctx.ui.slot({
      replace: "sidebar.footer",
      render: () => {
        const theme = ctx.theme;
        return dependencies.renderLabel(
          { opencodeVersion: ctx.app.version, vvocLabel: brandingFooterLabel() },
          {
            muted: theme.text.muted,
            success: theme.text.feedback.success.base,
            text: theme.text.base,
          },
        );
      },
    });
  } catch {
    // Fail-soft: no combined footer for this session.
    return () => undefined;
  }
}
// END_BLOCK_REGISTER_BRANDING_FOOTER
