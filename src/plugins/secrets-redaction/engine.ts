// FILE: src/plugins/secrets-redaction/engine.ts
// VERSION: 1.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Core redaction engine — performs find/replace of secrets with placeholders in text.
//   SCOPE: text scanning, overlap resolution, match sorting, zero-width match guard, capture-group
//          (context-anchored) redaction spans, idempotent skipping of well-formed placeholders, and replacement
//   DEPENDS: session, patterns
//   LINKS: [M-PLUGIN-SECRETS-REDACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   redactText - replaces secrets in text with placeholders, returns changed text + match list
//   Match - Regex match result.
//   RedactResult - Overall redaction operation result.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [secrets reliability overhaul - Redaction became idempotent (a value that is itself a well-formed placeholder is left untouched, so re-redacting redacted text no longer chains placeholders) and context-anchored builtin rules redact only their declared capture-group span via the hasIndices flag, preserving the surrounding context text such as a Bearer prefix.]
// END_CHANGE_SUMMARY

import { type PatternRule, type PatternSet } from "./patterns.js";
import { getPlaceholderMatcher, type PlaceholderSession } from "./session.js";

export interface Match {
  start: number;
  end: number;
  original: string;
  placeholder: string;
  category: string;
}

export interface RedactResult {
  text: string;
  matches: Match[];
}

interface Candidate {
  rule: PatternRule;
  start: number;
  end: number;
  value: string;
}

/**
 * Collect every match span as {start, end, value}. A rule with a `group`
 * contributes only its declared capture-group span (the credential), so
 * context text such as the `Bearer ` prefix stays verbatim; spans are derived
 * from the ES2022 hasIndices data instead of re-scanning the match text.
 */
function collectCandidates(rules: PatternRule[], text: string): Candidate[] {
  const candidates: Candidate[] = [];

  for (const rule of rules) {
    const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const re = new RegExp(rule.pattern.source, `${flags}d`);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const span = resolveSpan(rule, match);
      if (span === undefined) {
        // Zero-width (or group-less) spans have nothing to redact; advance
        // manually to avoid an infinite loop on lookahead/anchor patterns.
        re.lastIndex += 1;
        continue;
      }
      candidates.push({ rule, start: span[0], end: span[1], value: span[2] });
    }
  }

  candidates.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - b.start - (a.end - a.start);
  });

  return candidates;
}

function resolveSpan(
  rule: PatternRule,
  match: RegExpExecArray,
): [number, number, string] | undefined {
  if (rule.group === undefined) {
    if (match[0].length === 0) return undefined;
    const start = match.index!;
    return [start, start + match[0].length, match[0]];
  }
  const indices = match.indices?.[rule.group];
  const value = match[rule.group];
  if (indices === undefined || value === undefined || indices[0] === indices[1]) {
    return undefined;
  }
  return [indices[0], indices[1], value];
}

function overlapsSelected(start: number, selected: Match[]): boolean {
  const lastSelected = selected[selected.length - 1];
  if (!lastSelected) {
    return false;
  }

  return start < lastSelected.end;
}

export function redactText(
  input: string,
  patternSet: PatternSet,
  session: PlaceholderSession,
): RedactResult {
  if (!input || patternSet.rules.length === 0) {
    return { text: input, matches: [] };
  }

  const sorted = collectCandidates(patternSet.rules, input);
  // Idempotency guard: a value that is itself a well-formed placeholder is
  // never re-redacted, so repeated hooks/history replay cannot chain a
  // placeholder into a new placeholder and restoration always returns the
  // original value.
  const placeholderShape = getPlaceholderMatcher(session.prefix);
  const matches: Match[] = [];

  for (const { rule, start, end, value } of sorted) {
    if (placeholderShape.test(value)) {
      continue;
    }

    if (patternSet.exclude.has(value.toLowerCase())) {
      continue;
    }

    if (overlapsSelected(start, matches)) {
      continue;
    }

    const placeholder = session.getOrCreatePlaceholder(value, rule.category);
    matches.push({ start, end, original: value, placeholder, category: rule.category });
  }

  let result = "";
  let lastIndex = 0;

  for (const m of matches) {
    result += input.slice(lastIndex, m.start);
    result += m.placeholder;
    lastIndex = m.end;
  }
  result += input.slice(lastIndex);

  return { text: result, matches };
}
