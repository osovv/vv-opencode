// FILE: src/plugins/secrets-redaction/deep.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deep traversal helpers for restoring/redacting placeholders in nested objects and arrays.
//   SCOPE: copy-on-write object/array traversal that never writes into the provided value, cycle-safe with a WeakMap from original to owned copy, and media data-URL pass-through (base64 media bodies are opaque payloads, not secrets)
//   DEPENDS: session, restore, engine
//   LINKS: [M-PLUGIN-SECRETS-REDACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   restoreDeep - restores placeholders into owned copies of nested objects/arrays
//   redactDeep - redacts secrets into owned copies of nested objects/arrays
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [FIX-MEDIA-400 - redactDeep/restoreDeep pass media data URLs (image/video/audio/pdf base64) through byte-exact: the builtin bearer_token rule matches every 32+ character [A-Za-z0-9_-] run inside a base64 body, so redacting a read tool result's media part corrupted provider-bound images and PDFs with placeholder text (CAS-747 media-400).]
// END_CHANGE_SUMMARY

import { type PlaceholderSession } from "./session.js";
import { type PatternSet } from "./patterns.js";
import { redactText } from "./engine.js";
import { restoreText } from "./restore.js";

// START_BLOCK_MEDIA_GUARD
/**
 * Media data URLs are opaque payloads, not secrets: their base64 bodies are
 * sequences of 32+ character [A-Za-z0-9_-] runs bounded by `+`, `/` and `=`,
 * which the builtin bearer_token rule matches. Redacting such a string
 * corrupts the media for the provider (placeholder text inside a base64 body
 * fails provider-side media parsing), so both redactDeep and restoreDeep pass
 * these strings through byte-exact.
 */
const MEDIA_DATA_URL_PATTERN =
  /^data:(?:image|video|audio|application)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i;

function isMediaDataUrl(text: string): boolean {
  return MEDIA_DATA_URL_PATTERN.test(text);
}
// END_BLOCK_MEDIA_GUARD

// START_BLOCK_DEEP_COPY
/**
 * Copy-on-write deep traversal shared by restore and redact. Arrays and objects
 * are rebuilt into owned copies, so the host-provided value — which the native
 * host may freeze — is never written to. A WeakMap records original -> copy so a
 * cyclic or shared reference resolves to one consistent copy instead of
 * recursing forever. String leaves go through `transform`, except media data
 * URLs, which are passed through byte-exact; other primitives are returned
 * unchanged.
 */
function deepCopyWithText(
  value: unknown,
  transform: (text: string) => string,
  seen: WeakMap<object, unknown>,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (isMediaDataUrl(value)) return value;
    return transform(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }
  if (typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (let index = 0; index < value.length; index += 1) {
      copy.push(deepCopyWithText(value[index], transform, seen));
    }
    return copy;
  }

  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const key of Object.keys(source)) {
    copy[key] = deepCopyWithText(source[key], transform, seen);
  }
  return copy;
}
// END_BLOCK_DEEP_COPY

export function restoreDeep(value: unknown, session: PlaceholderSession): unknown {
  return deepCopyWithText(value, (text) => restoreText(text, session), new WeakMap());
}

export function redactDeep(
  value: unknown,
  patternSet: PatternSet,
  session: PlaceholderSession,
): unknown {
  return deepCopyWithText(
    value,
    (text) => redactText(text, patternSet, session).text,
    new WeakMap(),
  );
}
