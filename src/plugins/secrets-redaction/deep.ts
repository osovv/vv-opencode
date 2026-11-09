// FILE: src/plugins/secrets-redaction/deep.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Deep traversal helpers for restoring/redacting placeholders in nested objects and arrays.
//   SCOPE: copy-on-write object/array traversal that never writes into the provided value, cycle-safe with a WeakMap from original to owned copy; a media-leaf guard preserves opaque base64/data-URL payloads byte-for-byte during redaction; a strict restore traversal that fails closed on unresolved references
//   DEPENDS: session, restore, engine
//   LINKS: [M-PLUGIN-SECRETS-REDACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   isOpaqueMediaText - true when a string leaf is a base64/data-URL media payload, not prose
//   restoreDeep - restores placeholders into owned copies of nested objects/arrays
//   restoreDeepStrict - restores known references and throws on unresolved placeholder references
//   redactDeep - redacts secrets into owned copies of nested objects/arrays
//   redactDeepMediaAware - redacts secrets while preserving opaque media leaves byte-for-byte
//   StrictRestoreContext - Tool and session identity carried into strict failures (re-exported).
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [secrets reliability overhaul - Added the media-leaf guard: redaction of structured tool-call input and tool-result values now preserves data-URL and long pure-base64 media payloads byte-for-byte instead of rewriting them into placeholders (issue: base64 media corruption), while textual leaves, small values, and metadata still redact; added restoreDeepStrict so an unresolved placeholder reference throws before tool execution.]
// END_CHANGE_SUMMARY

import { type PlaceholderSession } from "./session.js";
import { type PatternSet } from "./patterns.js";
import { redactText } from "./engine.js";
import { restoreText, restoreTextStrict, type StrictRestoreContext } from "./restore.js";

export type { StrictRestoreContext };

// START_BLOCK_DEEP_COPY
/**
 * Copy-on-write deep traversal shared by restore and redact. Arrays and objects
 * are rebuilt into owned copies, so the host-provided value — which the native
 * host may freeze — is never written to. A WeakMap records original -> copy so a
 * cyclic or shared reference resolves to one consistent copy instead of
 * recursing forever. String leaves go through `transform`; other primitives are
 * returned unchanged.
 */
function deepCopyWithText(
  value: unknown,
  transform: (text: string) => string,
  seen: WeakMap<object, unknown>,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return transform(value);
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

// START_BLOCK_MEDIA_GUARD
/**
 * Media-leaf predicate for redaction. A string leaf is treated as an opaque
 * media payload — and preserved byte-for-byte — when it is
 * (a) a `data:<accepted mime>;base64,…` URL for image/application-pdf/audio/
 *     video content, or
 * (b) at least 512 characters of the pure base64/base64url alphabet with
 *     optional line breaks.
 *
 * Textual leaves, small values, and metadata still redact. Documented
 * limitation: long base64-encoded secrets hidden inside media-like payloads
 * are not scanned; media content itself is never OCR-scanned.
 */
export function isOpaqueMediaText(text: string): boolean {
  if (text.length < 512 && !MEDIA_DATA_URL_PREFIX.test(text)) {
    return false;
  }
  if (MEDIA_DATA_URL.test(text)) {
    return true;
  }
  return text.length >= 512 && PURE_BASE64_BLOB.test(text);
}

const MEDIA_DATA_URL_PREFIX = /^data:[^,;]{1,128};base64,/;
const MEDIA_DATA_URL =
  /^data:(?:image\/[a-z0-9.+-]+|application\/pdf|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+);base64,[A-Za-z0-9+/=\s]+$/i;
const PURE_BASE64_BLOB = /^[A-Za-z0-9+/\-_=\s]{512,}$/;
// END_BLOCK_MEDIA_GUARD

export function restoreDeep(value: unknown, session: PlaceholderSession): unknown {
  return deepCopyWithText(value, (text) => restoreText(text, session), new WeakMap());
}

export function restoreDeepStrict(
  value: unknown,
  session: PlaceholderSession,
  context: StrictRestoreContext,
): unknown {
  return deepCopyWithText(
    value,
    (text) => restoreTextStrict(text, session, context),
    new WeakMap(),
  );
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

/**
 * Redaction used for structured tool-call input and tool-result values: opaque
 * media leaves are preserved byte-for-byte so base64 image/PDF/audio/video
 * payloads are never rewritten into placeholders; textual leaves still redact.
 */
export function redactDeepMediaAware(
  value: unknown,
  patternSet: PatternSet,
  session: PlaceholderSession,
): unknown {
  return deepCopyWithText(
    value,
    (text) => (isOpaqueMediaText(text) ? text : redactText(text, patternSet, session).text),
    new WeakMap(),
  );
}
