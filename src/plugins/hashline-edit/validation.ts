// FILE: src/plugins/hashline-edit/validation.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Parse and validate hashline references with optional context-anchored hashes against the current file snapshot before edits are applied.
//   SCOPE: Anchor normalization, line reference parsing with optional anchor hash, full-batch validation with anchor-hash verification, mismatch diagnostics, and compatibility fallback for legacy hashes.
//   DEPENDS: [src/plugins/hashline-edit/constants.ts, src/plugins/hashline-edit/hash-computation.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LineRef - Parsed `{ line, hash, anchorHash? }` structure for a normalized hashline anchor.
//   normalizeLineRef - Strip copied prefixes and inline content from a raw anchor string.
//   parseLineRef - Parse a normalized hashline anchor and fail loudly on malformed references.
//   validateLineRef - Validate a single anchor against the current file lines including context-anchored hash.
//   validateLineRefs - Validate a batch of anchors and aggregate mismatches.
//   HashlineMismatchError - Rich mismatch error that includes updated surrounding anchors.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.3.0 - Anchor normalization now preserves context-anchor hashes when refs contain spaces around both separators.]
//   LAST_CHANGE: [v0.2.0 - Added optional context-anchored hash support to LineRef, isCompatibleLineHash, validateLineRef/validateLineRefs, mismatch formatting, and remap generation for collision-resistant anchors.]
// END_CHANGE_SUMMARY

import { HASHLINE_REF_PATTERN } from "./constants.js";
import { computeAnchorHash, computeLegacyLineHash, computeLineHash } from "./hash-computation.js";

export interface LineRef {
  line: number;
  hash: string;
  anchorHash?: string;
}

interface HashMismatch {
  line: number;
  expected: string;
  expectedAnchor?: string;
}

const MISMATCH_CONTEXT = 2;
const LINE_REF_EXTRACT_PATTERN = /([0-9]+#[ZPMQVRWSNKTXJBYH]{2}(?:#[ZPMQVRWSNKTXJBYH]{2})?)/;
const ANCHOR_HASH_EXTRACT_RE = /#([ZPMQVRWSNKTXJBYH]{2})$/;

function isLineHashCompatible(line: number, content: string, hash: string): boolean {
  return computeLineHash(line, content) === hash || computeLegacyLineHash(line, content) === hash;
}

function isCompatibleLineHash(
  line: number,
  content: string,
  hash: string,
  prevContent: string | undefined,
  nextContent: string | undefined,
  anchorHash: string | undefined,
): boolean {
  if (!isLineHashCompatible(line, content, hash)) {
    return false;
  }
  if (anchorHash) {
    const expected = computeAnchorHash(line, prevContent, content, nextContent);
    if (expected !== anchorHash) return false;
  }
  return true;
}

export function normalizeLineRef(ref: string): string {
  const originalTrimmed = ref.trim();
  let trimmed = originalTrimmed;
  trimmed = trimmed.replace(/^(?:>>>|[+-])\s*/, "");
  trimmed = trimmed.replace(/\s*#\s*/g, "#");
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
      anchorHash: match[3] || undefined,
    };
  }

  const hashIndex = normalized.indexOf("#");
  if (hashIndex > 0) {
    const prefix = normalized.slice(0, hashIndex);
    const suffix = normalized.slice(hashIndex + 1);
    if (
      !/^\d+$/.test(prefix) &&
      /^[ZPMQVRWSNKTXJBYH]{2}(?:#[ZPMQVRWSNKTXJBYH]{2})?$/.test(suffix)
    ) {
      throw new Error(
        `Invalid line reference: "${ref}". "${prefix}" is not a line number. Use the exact line number from the latest read output.`,
      );
    }
  }

  throw new Error(
    `Invalid line reference format: "${ref}". Expected format: "{line_number}#{hash_id}" or "{line_number}#{hash_id}#{anchor_hash}"`,
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
      const actualAnchor = computeAnchorHash(
        mismatch.line,
        fileLines[mismatch.line - 2],
        fileLines[mismatch.line - 1] ?? "",
        fileLines[mismatch.line],
      );
      const oldKey = mismatch.expectedAnchor
        ? `${mismatch.line}#${mismatch.expected}#${mismatch.expectedAnchor}`
        : `${mismatch.line}#${mismatch.expected}`;
      const newKey = `${mismatch.line}#${actual}#${actualAnchor}`;
      remaps.set(oldKey, newKey);
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
      const anchor = computeAnchorHash(line, fileLines[line - 2], content, fileLines[line]);
      const formatted = `${line}#${hash}#${anchor}|${content}`;
      output.push(mismatchByLine.has(line) ? `>>> ${formatted}` : `    ${formatted}`);
    }

    return output.join("\n");
  }
}

function extractHashFromRef(ref: string): string | null {
  const match = ref.trim().match(ANCHOR_HASH_EXTRACT_RE);
  return match ? match[1]! : null;
}

function suggestLineForHash(ref: string, lines: string[]): string | null {
  const hash = extractHashFromRef(ref);
  if (!hash) return null;
  for (let index = 0; index < lines.length; index += 1) {
    if (isLineHashCompatible(index + 1, lines[index] ?? "", hash)) {
      const actual = computeLineHash(index + 1, lines[index] ?? "");
      const anchor = computeAnchorHash(
        index + 1,
        lines[index - 1],
        lines[index] ?? "",
        lines[index + 1],
      );
      return `Did you mean "${index + 1}#${actual}#${anchor}"?`;
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
  const { line, hash, anchorHash } = parseLineRefWithHint(ref, lines);
  if (line < 1 || line > lines.length) {
    throw new Error(`Line number ${line} out of bounds. File has ${lines.length} lines.`);
  }

  const content = lines[line - 1] ?? "";
  const prevContent = line > 1 ? lines[line - 2] : undefined;
  const nextContent = line < lines.length ? lines[line] : undefined;
  if (!isCompatibleLineHash(line, content, hash, prevContent, nextContent, anchorHash)) {
    throw new HashlineMismatchError([{ line, expected: hash, expectedAnchor: anchorHash }], lines);
  }
}

export function validateLineRefs(lines: string[], refs: string[]): void {
  const mismatches: HashMismatch[] = [];

  for (const ref of refs) {
    const { line, hash, anchorHash } = parseLineRefWithHint(ref, lines);
    if (line < 1 || line > lines.length) {
      throw new Error(`Line number ${line} out of bounds (file has ${lines.length} lines)`);
    }

    const content = lines[line - 1] ?? "";
    const prevContent = line > 1 ? lines[line - 2] : undefined;
    const nextContent = line < lines.length ? lines[line] : undefined;
    if (!isCompatibleLineHash(line, content, hash, prevContent, nextContent, anchorHash)) {
      mismatches.push({ line, expected: hash, expectedAnchor: anchorHash });
    }
  }

  if (mismatches.length > 0) {
    throw new HashlineMismatchError(mismatches, lines);
  }
}
