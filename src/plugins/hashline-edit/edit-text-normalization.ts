// FILE: src/plugins/hashline-edit/edit-text-normalization.ts
// VERSION: 0.5.0
// START_MODULE_CONTRACT
//   PURPOSE: Normalize edit payload text so copied hashline rows and accidental diff markers do not corrupt replacements, and trim only provably accidental echo lines.
//   SCOPE: Prefix stripping, line splitting, exact-match insert echo trimming with reporting, and exact-match range-boundary echo trimming with reporting.
//   DEPENDS: []
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   stripLinePrefixes - Remove copied hashline or diff prefixes when most payload lines include them.
//   toNewLines - Normalize string or string[] payloads into plain content lines.
//   EchoTrimResult - Trimmed payload lines plus the number of exact echo lines removed.
//   stripExactInsertEcho - Remove a leading payload line that exactly duplicates the append anchor line.
//   stripExactInsertBeforeEcho - Remove a trailing payload line that exactly duplicates the prepend anchor line.
//   BoundaryEchoTrimResult - Trimmed payload lines plus removed leading/trailing boundary echo counts.
//   stripExactBoundaryEchoes - Remove exact copies of surviving neighbor lines from over-long replace payloads.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.5.0 - Replaced whitespace-insensitive autocorrect helpers with exact-match, reported echo trimming so valid payloads apply literally.]
// END_CHANGE_SUMMARY

const HASHLINE_PREFIX_RE =
  /^\s*(?:>>>|>>)?\s*\d+\s*#\s*[ZPMQVRWSNKTXJBYH]{2}(?:\s*#\s*[ZPMQVRWSNKTXJBYH]{2})?\|/;
const DIFF_PLUS_RE = /^[+](?![+])/;

export function stripLinePrefixes(lines: string[]): string[] {
  let hashPrefixCount = 0;
  let diffPlusCount = 0;
  let nonEmpty = 0;

  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    nonEmpty += 1;
    if (HASHLINE_PREFIX_RE.test(line)) {
      hashPrefixCount += 1;
    }
    if (DIFF_PLUS_RE.test(line)) {
      diffPlusCount += 1;
    }
  }

  if (nonEmpty === 0) {
    return lines;
  }

  const stripHash = hashPrefixCount > 0 && hashPrefixCount >= nonEmpty * 0.5;
  const stripPlus = !stripHash && diffPlusCount > 0 && diffPlusCount >= nonEmpty * 0.5;
  if (!stripHash && !stripPlus) {
    return lines;
  }

  return lines.map((line) => {
    if (stripHash) {
      return line.replace(HASHLINE_PREFIX_RE, "");
    }
    if (stripPlus) {
      return line.replace(DIFF_PLUS_RE, "");
    }
    return line;
  });
}

export function toNewLines(input: string | string[]): string[] {
  if (Array.isArray(input)) {
    return stripLinePrefixes(input);
  }
  return stripLinePrefixes(input.split("\n"));
}

export interface EchoTrimResult {
  lines: string[];
  stripped: number;
}

/**
 * Remove a leading payload line that exactly duplicates the append anchor
 * line. Only byte-identical echoes are trimmed; whitespace-differing lines
 * are literal content and stay in the payload.
 */
export function stripExactInsertEcho(anchorLine: string, newLines: string[]): EchoTrimResult {
  if (newLines.length > 0 && newLines[0] === anchorLine) {
    return { lines: newLines.slice(1), stripped: 1 };
  }
  return { lines: newLines, stripped: 0 };
}

/**
 * Remove a trailing payload line that exactly duplicates the prepend anchor
 * line. Only byte-identical echoes are trimmed.
 */
export function stripExactInsertBeforeEcho(anchorLine: string, newLines: string[]): EchoTrimResult {
  if (newLines.length > 0 && newLines[newLines.length - 1] === anchorLine) {
    return { lines: newLines.slice(0, -1), stripped: 1 };
  }
  return { lines: newLines, stripped: 0 };
}

export interface BoundaryEchoTrimResult {
  lines: string[];
  droppedLeading: number;
  droppedTrailing: number;
}

/**
 * Remove exact copies of the surviving neighbor lines from a replace payload
 * that is longer than the replaced range. Payloads that are not longer than
 * their range are returned untouched so intentional boundary content is
 * never silently dropped.
 */
export function stripExactBoundaryEchoes(
  fileLines: string[],
  startLine: number,
  endLine: number,
  newLines: string[],
): BoundaryEchoTrimResult {
  const replacedCount = endLine - startLine + 1;
  if (newLines.length <= replacedCount) {
    return { lines: newLines, droppedLeading: 0, droppedTrailing: 0 };
  }

  let output = newLines;
  let droppedLeading = 0;
  let droppedTrailing = 0;

  const beforeIndex = startLine - 2;
  if (beforeIndex >= 0 && output[0] === fileLines[beforeIndex]) {
    output = output.slice(1);
    droppedLeading = 1;
  }

  const afterIndex = endLine;
  if (
    afterIndex < fileLines.length &&
    output.length > 0 &&
    output[output.length - 1] === fileLines[afterIndex]
  ) {
    output = output.slice(0, -1);
    droppedTrailing = 1;
  }

  return { lines: output, droppedLeading, droppedTrailing };
}
