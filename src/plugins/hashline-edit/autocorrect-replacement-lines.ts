// FILE: src/plugins/hashline-edit/autocorrect-replacement-lines.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Recover common model formatting mistakes in replacement payloads without changing user-requested semantics.
//   SCOPE: Merged-line expansion, recovery of uniquely wrapped original lines, and indentation restoration for paired replacements.
//   DEPENDS: []
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   autocorrectReplacementLines - Apply conservative autocorrections to replacement payload lines.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.0.0 - Initial GRACE compliance: added missing CHANGE_SUMMARY.]
// END_CHANGE_SUMMARY

function normalizeTokens(text: string): string {
  return text.replace(/\s+/g, "");
}

function stripTrailingContinuationTokens(text: string): string {
  return text.replace(/(?:&&|\|\||\?\?|\?|:|=|,|\+|-|\*|\/|\.|\()\s*$/u, "");
}

function stripMergeOperatorChars(text: string): string {
  return text.replace(/[|&?]/g, "");
}

function leadingWhitespace(text: string): string {
  return text.match(/^\s*/)?.[0] ?? "";
}

function restoreOldWrappedLines(originalLines: string[], replacementLines: string[]): string[] {
  if (originalLines.length === 0 || replacementLines.length < 2) {
    return replacementLines;
  }

  const canonicalToOriginal = new Map<string, { line: string; count: number }>();
  for (const line of originalLines) {
    const canonical = normalizeTokens(line);
    const existing = canonicalToOriginal.get(canonical);
    if (existing) {
      existing.count += 1;
      continue;
    }
    canonicalToOriginal.set(canonical, { line, count: 1 });
  }

  const candidates: Array<{ start: number; len: number; replacement: string; canonical: string }> =
    [];
  for (let start = 0; start < replacementLines.length; start += 1) {
    for (let length = 2; length <= 10 && start + length <= replacementLines.length; length += 1) {
      const span = replacementLines.slice(start, start + length);
      if (span.some((line) => line.trim().length === 0)) {
        continue;
      }
      const canonicalSpan = normalizeTokens(span.join(""));
      const original = canonicalToOriginal.get(canonicalSpan);
      if (original && original.count === 1 && canonicalSpan.length >= 6) {
        candidates.push({
          start,
          len: length,
          replacement: original.line,
          canonical: canonicalSpan,
        });
      }
    }
  }

  if (candidates.length === 0) {
    return replacementLines;
  }

  const canonicalCounts = new Map<string, number>();
  for (const candidate of candidates) {
    canonicalCounts.set(candidate.canonical, (canonicalCounts.get(candidate.canonical) ?? 0) + 1);
  }

  const uniqueCandidates = candidates.filter(
    (candidate) => (canonicalCounts.get(candidate.canonical) ?? 0) === 1,
  );
  if (uniqueCandidates.length === 0) {
    return replacementLines;
  }

  uniqueCandidates.sort((left, right) => right.start - left.start);
  const corrected = [...replacementLines];
  for (const candidate of uniqueCandidates) {
    corrected.splice(candidate.start, candidate.len, candidate.replacement);
  }
  return corrected;
}

function maybeExpandSingleLineMerge(originalLines: string[], replacementLines: string[]): string[] {
  if (replacementLines.length !== 1 || originalLines.length <= 1) {
    return replacementLines;
  }

  const merged = replacementLines[0] ?? "";
  const parts = originalLines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (parts.length !== originalLines.length) {
    return replacementLines;
  }

  const indices: number[] = [];
  let offset = 0;
  let orderedMatch = true;

  for (const part of parts) {
    let index = merged.indexOf(part, offset);
    let matchedLength = part.length;

    if (index === -1) {
      const stripped = stripTrailingContinuationTokens(part);
      if (stripped !== part) {
        index = merged.indexOf(stripped, offset);
        if (index !== -1) {
          matchedLength = stripped.length;
        }
      }
    }

    if (index === -1) {
      const segment = merged.slice(offset);
      const fuzzyIndex = stripMergeOperatorChars(segment).indexOf(stripMergeOperatorChars(part));
      if (fuzzyIndex !== -1) {
        let strippedPos = 0;
        let originalPos = 0;
        while (strippedPos < fuzzyIndex && originalPos < segment.length) {
          if (!/[|&?]/.test(segment[originalPos] ?? "")) {
            strippedPos += 1;
          }
          originalPos += 1;
        }
        index = offset + originalPos;
        matchedLength = part.length;
      }
    }

    if (index === -1) {
      orderedMatch = false;
      break;
    }

    indices.push(index);
    offset = index + matchedLength;
  }

  const expanded: string[] = [];
  if (orderedMatch) {
    for (let index = 0; index < indices.length; index += 1) {
      const start = indices[index] ?? 0;
      const end =
        index + 1 < indices.length ? (indices[index + 1] ?? merged.length) : merged.length;
      const candidate = merged.slice(start, end).trim();
      if (candidate.length === 0) {
        orderedMatch = false;
        break;
      }
      expanded.push(candidate);
    }
  }

  if (orderedMatch && expanded.length === originalLines.length) {
    return expanded;
  }

  const semicolonSplit = merged
    .split(/;\s+/)
    .map((line, index, array) => {
      if (index < array.length - 1 && !line.endsWith(";")) {
        return `${line};`;
      }
      return line;
    })
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (semicolonSplit.length === originalLines.length) {
    return semicolonSplit;
  }

  return replacementLines;
}

function restoreIndentForPairedReplacement(
  originalLines: string[],
  replacementLines: string[],
): string[] {
  if (originalLines.length !== replacementLines.length) {
    return replacementLines;
  }

  return replacementLines.map((line, index) => {
    if (line.length === 0) {
      return line;
    }
    if (leadingWhitespace(line).length > 0) {
      return line;
    }
    const indent = leadingWhitespace(originalLines[index] ?? "");
    if (indent.length === 0) {
      return line;
    }
    if ((originalLines[index] ?? "").trim() === line.trim()) {
      return line;
    }
    return `${indent}${line}`;
  });
}

export function autocorrectReplacementLines(
  originalLines: string[],
  replacementLines: string[],
): string[] {
  let next = replacementLines;
  next = maybeExpandSingleLineMerge(originalLines, next);
  next = restoreOldWrappedLines(originalLines, next);
  next = restoreIndentForPairedReplacement(originalLines, next);
  return next;
}
