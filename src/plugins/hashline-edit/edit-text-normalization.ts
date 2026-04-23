// FILE: src/plugins/hashline-edit/edit-text-normalization.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Normalize edit payload text so copied hashline rows and accidental diff markers do not corrupt replacements.
//   SCOPE: Prefix stripping, line splitting, indentation restoration, and echo-line trimming for insert/replace payloads.
//   DEPENDS: []
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   stripLinePrefixes - Remove copied hashline or diff prefixes when most payload lines include them.
//   toNewLines - Normalize string or string[] payloads into plain content lines.
//   restoreLeadingIndent - Reapply the template line indentation for obvious unindented replacements.
//   stripInsertAnchorEcho - Remove duplicated anchor echoes from append payloads.
//   stripInsertBeforeEcho - Remove duplicated anchor echoes from prepend payloads.
//   stripRangeBoundaryEcho - Remove duplicated surrounding lines accidentally included in replace payloads.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.0 - Made prepend echo stripping symmetric with append so single-line anchor echoes are removed instead of duplicating the anchor line.]
// END_CHANGE_SUMMARY

const HASHLINE_PREFIX_RE = /^\s*(?:>>>|>>)?\s*\d+\s*#\s*[ZPMQVRWSNKTXJBYH]{2}\|/;
const DIFF_PLUS_RE = /^[+](?![+])/;

function equalsIgnoringWhitespace(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  return left.replace(/\s+/g, "") === right.replace(/\s+/g, "");
}

function leadingWhitespace(text: string): string {
  return text.match(/^\s*/)?.[0] ?? "";
}

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

export function restoreLeadingIndent(templateLine: string, line: string): string {
  if (line.length === 0) {
    return line;
  }
  const templateIndent = leadingWhitespace(templateLine);
  if (templateIndent.length === 0) {
    return line;
  }
  if (leadingWhitespace(line).length > 0) {
    return line;
  }
  if (templateLine.trim() === line.trim()) {
    return line;
  }
  return `${templateIndent}${line}`;
}

export function stripInsertAnchorEcho(anchorLine: string, newLines: string[]): string[] {
  if (newLines.length === 0) {
    return newLines;
  }
  if (equalsIgnoringWhitespace(newLines[0] ?? "", anchorLine)) {
    return newLines.slice(1);
  }
  return newLines;
}

export function stripInsertBeforeEcho(anchorLine: string, newLines: string[]): string[] {
  if (newLines.length === 0) {
    return newLines;
  }
  if (equalsIgnoringWhitespace(newLines[newLines.length - 1] ?? "", anchorLine)) {
    return newLines.slice(0, -1);
  }
  return newLines;
}

export function stripRangeBoundaryEcho(
  lines: string[],
  startLine: number,
  endLine: number,
  newLines: string[],
): string[] {
  const replacedCount = endLine - startLine + 1;
  if (newLines.length <= 1 || newLines.length <= replacedCount) {
    return newLines;
  }

  let output = newLines;
  const beforeIndex = startLine - 2;
  if (beforeIndex >= 0 && equalsIgnoringWhitespace(output[0] ?? "", lines[beforeIndex] ?? "")) {
    output = output.slice(1);
  }

  const afterIndex = endLine;
  if (
    afterIndex < lines.length &&
    output.length > 0 &&
    equalsIgnoringWhitespace(output[output.length - 1] ?? "", lines[afterIndex] ?? "")
  ) {
    output = output.slice(0, -1);
  }

  return output;
}
