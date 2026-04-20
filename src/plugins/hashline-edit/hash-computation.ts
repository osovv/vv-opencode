// FILE: src/plugins/hashline-edit/hash-computation.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Compute stable short line hashes used by hashline read output and edit anchors.
//   SCOPE: Current and legacy line hash computation plus formatting helpers for rendered hashline rows.
//   DEPENDS: [src/plugins/hashline-edit/constants.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   computeLineHash - Compute the current two-character hash for a line using trailing-whitespace-insensitive content.
//   computeLegacyLineHash - Compute the previous whitespace-insensitive hash used for compatibility with earlier anchors.
//   formatHashLine - Render a `line#hash|content` row for read-output enhancement.
// END_MODULE_MAP

import { HASHLINE_DICT } from "./constants.js";

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

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

export function formatHashLine(lineNumber: number, content: string): string {
  return `${lineNumber}#${computeLineHash(lineNumber, content)}|${content}`;
}
