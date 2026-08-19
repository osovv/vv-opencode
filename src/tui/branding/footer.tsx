// FILE: src/tui/branding/footer.tsx
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Show a static vvoc version label in the OpenCode sidebar footer slot.
//   SCOPE: Version label text, muted theme rendering, and fail-soft sidebar_footer slot registration independent of analytics config.
//   DEPENDS: [@opencode-ai/plugin/tui, @opentui/solid, src/lib/package.ts, src/tui/color.ts]
//   LINKS: [M-TUI-BRANDING-FOOTER, M-PLUGIN-ANALYTICS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   BrandingDependencies - Injectable label node renderer for focused tests.
//   brandingFooterLabel - The rendered label text, e.g. "vvoc v1.2.11".
//   registerBrandingFooter - Registers the always-on sidebar_footer label.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-20-orphan-text-fix - Wrapped the footer label in a text element so raw strings always have a text parent as OpenTUI requires.]
// END_CHANGE_SUMMARY

import type { JSX } from "@opentui/solid";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { getPackageVersionSync } from "../../lib/package.js";
import { rgbaToHex } from "../color.js";

export type BrandingDependencies = {
  /** Renders the label node; defaults to the muted span. */
  renderLabel: (text: string, color: string) => JSX.Element;
};

const DEFAULT_DEPENDENCIES: BrandingDependencies = {
  renderLabel: (text, color) => (
    <text>
      <span style={{ fg: color }}>{text}</span>
    </text>
  ),
};

/** The rendered label, e.g. "vvoc v1.2.11". */
export function brandingFooterLabel(): string {
  return `vvoc v${getPackageVersionSync()}`;
}

// START_BLOCK_REGISTER_BRANDING_FOOTER
/**
 * Registers the branding footer in the "sidebar_footer" host slot.
 * Always on (independent of analytics config); returns silently when the slot
 * API is unavailable or registration fails.
 */
export function registerBrandingFooter(
  api: TuiPluginApi,
  dependencies: BrandingDependencies = DEFAULT_DEPENDENCIES,
): void {
  if (typeof api.slots?.register !== "function") return;
  try {
    api.slots.register({
      slots: {
        sidebar_footer: () => {
          const muted = api.theme.current.textMuted;
          const color = rgbaToHex(api.theme.current.textMuted);
          return dependencies.renderLabel(brandingFooterLabel(), color);
        },
      },
    });
  } catch {
    // Fail-soft: no footer for this session.
  }
}
// END_BLOCK_REGISTER_BRANDING_FOOTER
