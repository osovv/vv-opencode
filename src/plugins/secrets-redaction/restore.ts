// FILE: src/plugins/secrets-redaction/restore.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Restores placeholders in a single string back to original secret values, with a strict
//            tool-input variant that fails closed on unresolved secret references.
//   SCOPE: single-string placeholder → original lookup; strict variant that throws a value-free,
//          actionable SecretsReferenceUnresolvedError when a well-formed placeholder has no mapping
//   DEPENDS: session
//   LINKS: [M-PLUGIN-SECRETS-REDACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   restoreText - restores all placeholders in a string to original values
//   restoreTextStrict - restores known references and throws on any remaining well-formed placeholder
//   SecretsReferenceUnresolvedError - A tool input still contains an unmapped placeholder-shaped reference.
//   StrictRestoreContext - Tool and session identity carried into the strict error.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [secrets reliability overhaul - Added the strict tool-input restore path: known references restore, then any remaining well-formed placeholder throws SecretsReferenceUnresolvedError (code SECRETS_REFERENCE_UNRESOLVED) naming tool, session, and the placeholder token before any side effect — no fuzzy matching, no borrowed mappings. Plain restoreText keeps its signature for the stream paths.]
// END_CHANGE_SUMMARY

import { type PlaceholderSession } from "./session.js";
import { getPlaceholderRegex } from "./session.js";

/** Tool and session identity carried into strict-restore failures. */
export interface StrictRestoreContext {
  readonly tool: string;
  readonly sessionID: string;
}

/**
 * A tool input still contained a well-formed placeholder with no mapping in
 * this session's family (expired, evicted, foreign, or invented). The message
 * names only the placeholder token — safe by construction — never a secret.
 */
export class SecretsReferenceUnresolvedError extends Error {
  readonly code = "SECRETS_REFERENCE_UNRESOLVED";
  readonly tool: string;
  readonly sessionID: string;
  readonly placeholder: string;

  constructor(context: StrictRestoreContext, placeholder: string) {
    super(
      `SECRETS_REFERENCE_UNRESOLVED: tool "${context.tool}" in session ${context.sessionID} still references secret placeholder ${placeholder} with no mapping in this session's family. The referenced value is no longer mapped (expired, evicted, from another session family, or invented). Recovery: re-read the source to obtain the value again; do not paste the raw secret. If redaction is in the way, an explicitly disabled policy is the supported bypass.`,
    );
    this.name = "SecretsReferenceUnresolvedError";
    this.tool = context.tool;
    this.sessionID = context.sessionID;
    this.placeholder = placeholder;
  }
}

export function restoreText(input: string, session: PlaceholderSession): string {
  if (!input) return input;

  const regex = getPlaceholderRegex(session.prefix);
  return input.replace(regex, (placeholder) => {
    const original = session.lookup(placeholder);
    return original ?? placeholder;
  });
}

/**
 * Strict tool-input restoration: known references restore to their originals,
 * then any remaining well-formed placeholder throws before the tool runs, so
 * an unresolved reference can never reach local execution substituted for a
 * path or value. The scan matches the full reference grammar (prefix + token +
 * 12-hex digest + terminator), so text that merely contains the prefix, or an
 * intentionally single-underscore literal, passes through untouched.
 */
export function restoreTextStrict(
  input: string,
  session: PlaceholderSession,
  context: StrictRestoreContext,
): string {
  const restored = restoreText(input, session);
  const remaining = restored.match(getPlaceholderRegex(session.prefix));

  if (remaining !== null && remaining.length > 0) {
    // The first well-formed reference is enough to fail closed; every match is
    // a placeholder token, safe to name in the error.
    throw new SecretsReferenceUnresolvedError(context, remaining[0]!);
  }

  return restored;
}
