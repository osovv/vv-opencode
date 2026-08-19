// FILE: src/tui/color.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Convert OpenTUI RGBA theme values into color strings the OpenTUI solid span style reliably parses.
//   SCOPE: Six-digit hex formatting from RGBA components; alpha is intentionally dropped because 8-digit forms parse unreliably in @opentui/core.
//   DEPENDS: [none]
//   LINKS: [M-TUI-BRANDING-FOOTER, M-TUI-ANALYTICS-INDICATOR]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   rgbaToHex - Formats an RGBA-like theme color as #rrggbb.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-20-orphan-text-fix - Added reliable theme color formatting for text span foregrounds.]
// END_CHANGE_SUMMARY

/** RGBA-like theme color shape produced by the OpenCode TUI theme API. */
export type RgbaLike = {
  r: number;
  g: number;
  b: number;
  a: number;
};

/**
 * Formats an RGBA-like theme color as a six-digit hex string.
 * Alpha is dropped: rgba() strings and 8-digit hex parse unreliably in
 * @opentui/core, while #rrggbb parses exactly.
 */
export function rgbaToHex(color: RgbaLike): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}
