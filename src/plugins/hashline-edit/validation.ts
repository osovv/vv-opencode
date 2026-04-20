// FILE: src/plugins/hashline-edit/validation.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Parse and validate hashline references against the current file snapshot before edits are applied.
//   SCOPE: Anchor normalization, line reference parsing, full-batch validation, mismatch diagnostics, and compatibility fallback for legacy hashes.
//   DEPENDS: [src/plugins/hashline-edit/constants.ts, src/plugins/hashline-edit/hash-computation.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LineRef - Parsed `{ line, hash }` structure for a normalized hashline anchor.
//   normalizeLineRef - Strip copied prefixes and inline content from a raw anchor string.
//   parseLineRef - Parse a normalized hashline anchor and fail loudly on malformed references.
//   validateLineRef - Validate a single anchor against the current file lines.
//   validateLineRefs - Validate a batch of anchors and aggregate mismatches.
//   HashlineMismatchError - Rich mismatch error that includes updated surrounding anchors.
// END_MODULE_MAP

import { HASHLINE_REF_PATTERN } from "./constants.js";
import { computeLegacyLineHash, computeLineHash } from "./hash-computation.js";

export interface LineRef {
  line: number;
  hash: string;
}

interface HashMismatch {
  line: number;
  expected: string;
}

const MISMATCH_CONTEXT = 2;
const LINE_REF_EXTRACT_PATTERN = /([0-9]+#[ZPMQVRWSNKTXJBYH]{2})/;

function isCompatibleLineHash(line: number, content: string, hash: string): boolean {
  return computeLineHash(line, content) === hash || computeLegacyLineHash(line, content) === hash;
}

export function normalizeLineRef(ref: string): string {
  const originalTrimmed = ref.trim();
  let trimmed = originalTrimmed;
  trimmed = trimmed.replace(/^(?:>>>|[+-])\s*/, "");
  trimmed = trimmed.replace(/\s*#\s*/, "#");
  trimmed = trimmed.replace(/\|.*$/, "");
  trimmed = trimmed.trim();

  if (HASHLINE_REF_PATTERN.test(trimmed)) {
    return trimmed;
  }

  const extracted = trimmed.match(LINE_REF_EXTRACT_PATTERN);
  if (extracted) {
    return extracted[1]!;
  }

  return originalTrimmed;
}

export function parseLineRef(ref: string): LineRef {
  const normalized = normalizeLineRef(ref);
  const match = normalized.match(HASHLINE_REF_PATTERN);
  if (match) {
    return {
      line: Number.parseInt(match[1]!, 10),
      hash: match[2]!,
    };
  }

  const hashIndex = normalized.indexOf("#");
  if (hashIndex > 0) {
    const prefix = normalized.slice(0, hashIndex);
    const suffix = normalized.slice(hashIndex + 1);
    if (!/^\d+$/.test(prefix) && /^[ZPMQVRWSNKTXJBYH]{2}$/.test(suffix)) {
      throw new Error(
        `Invalid line reference: "${ref}". "${prefix}" is not a line number. Use the exact line number from the latest read output.`,
      );
    }
  }

  throw new Error(
    `Invalid line reference format: "${ref}". Expected format: "{line_number}#{hash_id}"`,
  );
}

export class HashlineMismatchError extends Error {
  readonly remaps: ReadonlyMap<string, string>;

  constructor(
    private readonly mismatches: HashMismatch[],
    private readonly fileLines: string[],
  ) {
    super(HashlineMismatchError.formatMessage(mismatches, fileLines));
    this.name = "HashlineMismatchError";

    const remaps = new Map<string, string>();
    for (const mismatch of mismatches) {
      const actual = computeLineHash(mismatch.line, fileLines[mismatch.line - 1] ?? "");
      remaps.set(`${mismatch.line}#${mismatch.expected}`, `${mismatch.line}#${actual}`);
    }
    this.remaps = remaps;
  }

  static formatMessage(mismatches: HashMismatch[], fileLines: string[]): string {
    const mismatchByLine = new Map<number, HashMismatch>();
    for (const mismatch of mismatches) {
      mismatchByLine.set(mismatch.line, mismatch);
    }

    const displayLines = new Set<number>();
    for (const mismatch of mismatches) {
      const low = Math.max(1, mismatch.line - MISMATCH_CONTEXT);
      const high = Math.min(fileLines.length, mismatch.line + MISMATCH_CONTEXT);
      for (let line = low; line <= high; line += 1) {
        displayLines.add(line);
      }
    }

    const sortedLines = [...displayLines].sort((left, right) => left - right);
    const output: string[] = [];
    output.push(
      `${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. Use updated {line_number}#{hash_id} references below (>>> marks changed lines).`,
    );
    output.push("");

    let previousLine = -1;
    for (const line of sortedLines) {
      if (previousLine !== -1 && line > previousLine + 1) {
        output.push("    ...");
      }
      previousLine = line;

      const content = fileLines[line - 1] ?? "";
      const hash = computeLineHash(line, content);
      const formatted = `${line}#${hash}|${content}`;
      output.push(mismatchByLine.has(line) ? `>>> ${formatted}` : `    ${formatted}`);
    }

    return output.join("\n");
  }
}

function suggestLineForHash(ref: string, lines: string[]): string | null {
  const hashMatch = ref.trim().match(/#([ZPMQVRWSNKTXJBYH]{2})$/);
  if (!hashMatch) {
    return null;
  }
  const hash = hashMatch[1]!;
  for (let index = 0; index < lines.length; index += 1) {
    if (isCompatibleLineHash(index + 1, lines[index] ?? "", hash)) {
      return `Did you mean "${index + 1}#${computeLineHash(index + 1, lines[index] ?? "")}"?`;
    }
  }
  return null;
}

function parseLineRefWithHint(ref: string, lines: string[]): LineRef {
  try {
    return parseLineRef(ref);
  } catch (error) {
    const hint = suggestLineForHash(ref, lines);
    if (hint && error instanceof Error) {
      throw new Error(`${error.message} ${hint}`);
    }
    throw error;
  }
}

export function validateLineRef(lines: string[], ref: string): void {
  const { line, hash } = parseLineRefWithHint(ref, lines);
  if (line < 1 || line > lines.length) {
    throw new Error(`Line number ${line} out of bounds. File has ${lines.length} lines.`);
  }

  const content = lines[line - 1] ?? "";
  if (!isCompatibleLineHash(line, content, hash)) {
    throw new HashlineMismatchError([{ line, expected: hash }], lines);
  }
}

export function validateLineRefs(lines: string[], refs: string[]): void {
  const mismatches: HashMismatch[] = [];

  for (const ref of refs) {
    const { line, hash } = parseLineRefWithHint(ref, lines);
    if (line < 1 || line > lines.length) {
      throw new Error(`Line number ${line} out of bounds (file has ${lines.length} lines)`);
    }

    const content = lines[line - 1] ?? "";
    if (!isCompatibleLineHash(line, content, hash)) {
      mismatches.push({ line, expected: hash });
    }
  }

  if (mismatches.length > 0) {
    throw new HashlineMismatchError(mismatches, lines);
  }
}
