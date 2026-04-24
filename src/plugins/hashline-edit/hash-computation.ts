// FILE: src/plugins/hashline-edit/hash-computation.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Compute stable short line hashes and context-anchored hashes used by hashline read output and edit anchors.
//   SCOPE: Current and legacy line hash computation, context-anchored hash computation, plus formatting helpers for rendered hashline rows.
//   DEPENDS: [src/plugins/hashline-edit/constants.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   computeLineHash - Compute the current two-character hash for a line using trailing-whitespace-insensitive content.
//   computeLegacyLineHash - Compute the previous whitespace-insensitive hash used for compatibility with earlier anchors.
//   computeAnchorHash - Compute a two-character context-anchored hash from surrounding lines for collision-resistant references.
//   formatHashLine - Render a `line#hash|content` row (backward-compatible short format).
//   formatHashAnchoredLine - Render a `line#hash#anchor|content` row with context-anchored hash.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.0 - Added context-anchored hash computation to improve collision resistance; updated read output to emit anchor hashes via formatHashAnchoredLine.]
// END_CHANGE_SUMMARY

import { HASHLINE_DICT } from "./constants.js";

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;
const RS = "\u241E";

function computeNormalizedLineHash(lineNumber: number, normalizedContent: string): string {
  const seed = RE_SIGNIFICANT.test(normalizedContent) ? 0 : lineNumber;
  const hash = Bun.hash.xxHash32(normalizedContent, seed);
  const index = hash % 256;
  return HASHLINE_DICT[index] ?? HASHLINE_DICT[0]!;
}

export function computeLineHash(lineNumber: number, content: string): string {
  return computeNormalizedLineHash(lineNumber, content.replace(/\r/g, "").trimEnd());
}

export function computeLegacyLineHash(lineNumber: number, content: string): string {
  return computeNormalizedLineHash(lineNumber, content.replace(/\r/g, "").replace(/\s+/g, ""));
}

export function computeAnchorHash(
  lineNumber: number,
  prevContent: string | undefined,
  content: string,
  nextContent: string | undefined,
): string {
  const clean = (s: string | undefined): string => (s ?? "").replace(/\r/g, "").trimEnd();
  const context = `${clean(prevContent)}${RS}${clean(content)}${RS}${clean(nextContent)}`;
  const hash = Bun.hash.xxHash32(context, lineNumber);
  const index = hash % 256;
  return HASHLINE_DICT[index] ?? HASHLINE_DICT[0]!;
}

export function formatHashLine(lineNumber: number, content: string): string {
  return `${lineNumber}#${computeLineHash(lineNumber, content)}|${content}`;
}

export function formatHashAnchoredLine(
  lineNumber: number,
  content: string,
  prevContent: string | undefined,
  nextContent: string | undefined,
): string {
  return `${lineNumber}#${computeLineHash(lineNumber, content)}#${computeAnchorHash(lineNumber, prevContent, content, nextContent)}|${content}`;
}
