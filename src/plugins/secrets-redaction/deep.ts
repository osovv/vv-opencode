// FILE: src/plugins/secrets-redaction/deep.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deep traversal helpers for restoring/redacting placeholders in nested objects and arrays.
//   SCOPE: copy-on-write object/array traversal that never writes into the provided value, cycle-safe with a WeakMap from original to owned copy
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
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009-SECRETS - restoreDeep/redactDeep rebuild arrays and objects into owned copies instead of assigning entries in place, so a host-frozen nested tool input can no longer trigger "Attempted to assign to readonly property"; a WeakMap records original -> copy to keep cycle and shared-reference safety. String-leaf results are unchanged.]
// END_CHANGE_SUMMARY

import { type PlaceholderSession } from "./session.js";
import { type PatternSet } from "./patterns.js";
import { redactText } from "./engine.js";
import { restoreText } from "./restore.js";

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
