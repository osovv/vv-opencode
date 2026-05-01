// FILE: src/plugins/secrets-redaction/deep.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deep traversal helpers for restoring/redacting placeholders in nested objects and arrays.
//   SCOPE: in-place object/array traversal, cycle-safe with WeakSet
//   DEPENDS: session, restore, engine
//   LINKS: knowledge-graph://plugins/secrets-redaction
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   restoreDeep - restores placeholders in objects/arrays in-place
//   redactDeep - redacts secrets in objects/arrays in-place
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.0.0 - Initial GRACE compliance: added missing CHANGE_SUMMARY.]
// END_CHANGE_SUMMARY

import { type PlaceholderSession } from "./session.js";
import { type PatternSet } from "./patterns.js";
import { redactText } from "./engine.js";
import { restoreText } from "./restore.js";

export function restoreDeep(value: unknown, session: PlaceholderSession): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return restoreText(value, session);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = restoreDeep(value[i], session) as never;
    }
    return value;
  }

  if (typeof value === "object") {
    const seen = new WeakSet();
    return restoreDeepObject(value as Record<string, unknown>, session, seen);
  }

  return value;
}

function restoreDeepObject(
  obj: Record<string, unknown>,
  session: PlaceholderSession,
  seen: WeakSet<object>,
): Record<string, unknown> {
  if (seen.has(obj)) return obj;
  seen.add(obj);

  for (const key of Object.keys(obj)) {
    obj[key] = restoreDeep(obj[key], session) as never;
  }

  return obj;
}

export function redactDeep(
  value: unknown,
  patternSet: PatternSet,
  session: PlaceholderSession,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value, patternSet, session).text;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = redactDeep(value[i], patternSet, session) as never;
    }
    return value;
  }

  if (typeof value === "object") {
    const seen = new WeakSet();
    return redactDeepObject(value as Record<string, unknown>, patternSet, session, seen);
  }

  return value;
}

function redactDeepObject(
  obj: Record<string, unknown>,
  patternSet: PatternSet,
  session: PlaceholderSession,
  seen: WeakSet<object>,
): Record<string, unknown> {
  if (seen.has(obj)) return obj;
  seen.add(obj);

  for (const key of Object.keys(obj)) {
    obj[key] = redactDeep(obj[key], patternSet, session) as never;
  }

  return obj;
}
