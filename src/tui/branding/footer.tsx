// FILE: src/tui/branding/footer.tsx
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Show a static vvoc version label in the OpenCode app_bottom slot without displacing host content.
//   SCOPE: Version label text, muted theme color via RGBA instance, id-carrying append-mode app_bottom slot registration, and fail-soft behavior.
//   DEPENDS: [@opencode-ai/plugin/tui, @opentui/solid, @opentui/core, src/lib/package.ts]
//   LINKS: [M-TUI-BRANDING-FOOTER, M-PLUGIN-ANALYTICS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   BrandingDependencies - Injectable label node renderer for focused tests.
//   brandingFooterLabel - The rendered label text, e.g. "vvoc v1.2.11".
//   registerBrandingFooter - Registers the always-on app_bottom version label.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-21-slot-mode-fix - Moved the label from single_winner sidebar_footer to append-mode app_bottom, passed theme RGBA directly as fg, and added a plugin id.]
// END_CHANGE_SUMMARY

import type { JSX } from "@opentui/solid";
import type { RGBA } from "@opentui/core";
import type { TuiPluginApi, TuiSlotContext } from "@opencode-ai/plugin/tui";
import { getPackageVersionSync } from "../../lib/package.js";

export type BrandingDependencies = {
  /** Renders the label node; defaults to the muted text element. */
  renderLabel: (text: string, color: RGBA) => JSX.Element;
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
 * Registers the branding label in the "app_bottom" host slot.
 *
 * app_bottom renders in append mode at the bottom of the app on every screen,
 * so the label coexists with any other plugin content and never displaces the
 * OpenCode sidebar or home footers (those slots are single_winner and owned by
 * OpenCode's internal footer plugins). Always on (independent of analytics
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
      order: 1000,
      slots: {
        app_bottom: (ctx: TuiSlotContext) => {
          return dependencies.renderLabel(brandingFooterLabel(), ctx.theme.current.textMuted);
        },
      },
    } as unknown as Parameters<TuiPluginApi["slots"]["register"]>[0];
    api.slots.register(plugin);
  } catch {
    // Fail-soft: no label for this session.
  }
}
// END_BLOCK_REGISTER_BRANDING_FOOTER
