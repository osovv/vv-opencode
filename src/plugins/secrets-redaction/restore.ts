// FILE: src/plugins/secrets-redaction/restore.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Restores placeholders in a single string back to original secret values.
//   SCOPE: single-string placeholder → original lookup
//   DEPENDS: session
//   LINKS: knowledge-graph://plugins/secrets-redaction
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   restoreText - restores all placeholders in a string to original values
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.0.0 - Initial GRACE compliance: added missing CHANGE_SUMMARY.]
// END_CHANGE_SUMMARY

import { type PlaceholderSession } from "./session.js";
import { getPlaceholderRegex } from "./session.js";

export function restoreText(input: string, session: PlaceholderSession): string {
  if (!input) return input;

  const regex = getPlaceholderRegex(session["prefix"] as unknown as string);
  return input.replace(regex, (placeholder) => {
    const original = session.lookup(placeholder);
    return original ?? placeholder;
  });
}
