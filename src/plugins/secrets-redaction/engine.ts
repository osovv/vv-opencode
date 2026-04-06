// FILE: src/plugins/secrets-redaction/engine.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Core redaction engine — performs find/replace of secrets with placeholders in text.
//   SCOPE: text scanning, match sorting, interval arithmetic, replacement
//   DEPENDS: session, patterns
//   LINKS: knowledge-graph://plugins/secrets-redaction
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   redactText - replaces secrets in text with placeholders, returns changed text + match list
// END_MODULE_MAP

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

function subtractCovered(intervals: [number, number][]): [number, number][] {
  if (intervals.length === 0) return [];

  intervals.sort((a, b) => a[0] - b[0]);

  const result: [number, number][] = [];
  let currentEnd = intervals[0][0];

  for (const [start, end] of intervals) {
    if (start > currentEnd) {
      result.push([currentEnd, start]);
    }
    if (end > currentEnd) {
      currentEnd = end;
    }
  }

  return result;
}

function insertCovered(
  intervals: [number, number][],
  newInterval: [number, number],
): [number, number][] {
  const merged = [...intervals, newInterval];
  merged.sort((a, b) => a[0] - b[0]);

  const result: [number, number][] = [];
  for (const interval of merged) {
    if (result.length > 0 && interval[0] <= result[result.length - 1][1]) {
      result[result.length - 1][1] = Math.max(result[result.length - 1][1], interval[1]);
    } else {
      result.push([...interval]);
    }
  }

  return result;
}

function sortByPositionDesc(
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
    if (aStart !== bStart) return bStart - aStart;
    return b.match[0].length - a.match[0].length;
  });

  return allMatches.map((x) => ({ rule: x.rule, matches: x.match }));
}

export function redactText(
  input: string,
  patternSet: PatternSet,
  session: PlaceholderSession,
): RedactResult {
  if (!input || patternSet.rules.length === 0) {
    return { text: input, matches: [] };
  }

  const sorted = sortByPositionDesc(patternSet.rules, input);

  const covered: [number, number][] = [];
  const matches: Match[] = [];

  for (const { rule, matches: match } of sorted) {
    const start = match.index!;
    const end = start + match[0].length;
    const value = match[0];

    if (patternSet.exclude.has(value.toLowerCase())) {
      continue;
    }

    const gaps = subtractCovered(covered);
    const isInside = gaps.every(([gStart, gEnd]) => start >= gStart && end <= gEnd);
    if (isInside) continue;

    const placeholder = session.getOrCreatePlaceholder(value, rule.category);
    matches.push({ start, end, original: value, placeholder, category: rule.category });

    const remainingGaps: [number, number][] = [];
    for (const [gStart, gEnd] of gaps) {
      if (start >= gEnd || end <= gStart) {
        remainingGaps.push([gStart, gEnd]);
      } else {
        if (start > gStart) {
          remainingGaps.push([gStart, start]);
        }
        if (end < gEnd) {
          remainingGaps.push([end, gEnd]);
        }
      }
    }

    covered.length = 0;
    for (const g of remainingGaps) {
      insertCovered(covered, g);
    }
  }

  const sortedMatches = [...matches].sort((a, b) => a.start - b.start);

  let result = "";
  let lastIndex = 0;

  for (const m of sortedMatches) {
    result += input.slice(lastIndex, m.start);
    result += m.placeholder;
    lastIndex = m.end;
  }
  result += input.slice(lastIndex);

  return { text: result, matches: sortedMatches };
}
