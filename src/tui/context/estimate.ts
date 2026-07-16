// FILE: src/tui/context/estimate.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide deterministic, provider-neutral token approximations for context category comparison.
//   SCOPE: Plain text and JSON-compatible value estimation only; no provider-specific tokenizer claims.
//   DEPENDS: [none]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   estimateTextTokens - Approximate text tokens with separate ASCII and non-ASCII weighting.
//   estimateValueTokens - Serialize a JSON-compatible value and estimate its token count.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added deterministic provider-neutral context estimates.]
// END_CHANGE_SUMMARY

// START_BLOCK_TOKEN_ESTIMATION
export function estimateTextTokens(value: string | undefined): number {
  if (!value?.trim()) return 0;

  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) {
      ascii += 1;
    } else {
      nonAscii += 1;
    }
  }

  return Math.max(1, Math.ceil(ascii / 4 + nonAscii));
}

export function estimateValueTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return estimateTextTokens(value);

  try {
    return estimateTextTokens(JSON.stringify(value));
  } catch {
    return estimateTextTokens(String(value));
  }
}
// END_BLOCK_TOKEN_ESTIMATION
