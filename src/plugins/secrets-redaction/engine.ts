// FILE: src/plugins/secrets-redaction/engine.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Core redaction engine — performs find/replace of secrets with placeholders in text.
//   SCOPE: text scanning, overlap resolution, match sorting, and replacement
//   DEPENDS: session, patterns
//   LINKS: knowledge-graph://plugins/secrets-redaction
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   redactText - replaces secrets in text with placeholders, returns changed text + match list
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.0 - Fixed overlap handling so first and wider earlier matches redact correctly instead of being skipped entirely.]
// END_CHANGE_SUMMARY

import { type PatternRule, type PatternSet } from "./patterns.js";
import { type PlaceholderSession } from "./session.js";

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

function sortByPositionAsc(
  rules: PatternRule[],
  text: string,
): Array<{ rule: PatternRule; matches: RegExpMatchArray }> {
  const allMatches: Array<{ rule: PatternRule; match: RegExpMatchArray }> = [];

  for (const rule of rules) {
    const re = new RegExp(
      rule.pattern.source,
      rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`,
    );
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      allMatches.push({ rule, match: match as RegExpMatchArray });
    }
  }

  allMatches.sort((a, b) => {
    const aStart = a.match.index!;
    const bStart = b.match.index!;
    if (aStart !== bStart) return aStart - bStart;
    return b.match[0].length - a.match[0].length;
  });

  return allMatches.map((x) => ({ rule: x.rule, matches: x.match }));
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

  const sorted = sortByPositionAsc(patternSet.rules, input);
  const matches: Match[] = [];

  for (const { rule, matches: match } of sorted) {
    const start = match.index!;
    const end = start + match[0].length;
    const value = match[0];

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
