#!/usr/bin/env bun
// FILE: scripts/check-grace-markup.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Enforce the repository-owned expected set and cardinality rules for file-local GRACE semantic markup.
//   SCOPE: Recursive src/scripts TypeScript discovery, explicit raw/declaration exceptions, required paired module blocks, hash-prefixed anchor corruption detection, exact FILE headers, and one current LAST_CHANGE per governed file.
//   DEPENDS: [node:fs, node:path]
//   LINKS: M-RELEASE-AUTOMATION, V-M-RELEASE-AUTOMATION
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   GRACE_MARKUP_EXCEPTIONS - Explicit files that intentionally do not contain file-local GRACE markup.
//   GOVERNED_ROOTS - Source roots whose TypeScript files are expected to carry file-local GRACE markup.
//   REQUIRED_MARKER_PAIRS - Required semantic block start/end markers.
//   MALFORMED_HASH_PREFIX_PATTERN - Detect embedded hashline read prefixes before semantic metadata.
//   GraceMarkupIssueCode - Stable repository markup failure codes.
//   GraceMarkupIssue - Path-aware markup validation result.
//   toPosixPath - Normalize discovered paths for repository-relative comparison.
//   collectSourceFiles - Discover the expected governed TypeScript and TSX file set.
//   escapeRegExp - Escape literal semantic markers for regular-expression matching.
//   countCommentMarker - Count exact standalone semantic comment markers.
//   countLastChangeComments - Count current LAST_CHANGE entries.
//   validateGovernedFile - Validate one governed file's header, block pairing, corruption, and summary cardinality.
//   collectGraceMarkupIssues - Inspect the expected governed set and return deterministic issues.
//   checkGraceMarkup - Print repository markup diagnostics and return a process-style status code.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-GRACE-INTEGRITY-AND-COVERAGE-REMEDIATION - Added deterministic expected-file, anchor-pair, corruption, and single-LAST_CHANGE validation.]
// END_CHANGE_SUMMARY

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const GRACE_MARKUP_EXCEPTIONS = [
  "src/env.d.ts",
  "src/plugins/workflow/system-instruction.md",
] as const;

const GOVERNED_ROOTS = ["src", "scripts"] as const;
const REQUIRED_MARKER_PAIRS = [
  ["START_MODULE_CONTRACT", "END_MODULE_CONTRACT"],
  ["START_MODULE_MAP", "END_MODULE_MAP"],
  ["START_CHANGE_SUMMARY", "END_CHANGE_SUMMARY"],
] as const;
const MALFORMED_HASH_PREFIX_PATTERN =
  /^\s*\/\/\s+[A-Z0-9]{2}#[A-Z0-9]{2}\|\/\/\s+(?:FILE:|VERSION:|START_|END_)/m;

export type GraceMarkupIssueCode =
  | "MISSING_EXPECTED_FILE"
  | "MISSING_FILE_HEADER"
  | "MISSING_MARKER"
  | "DUPLICATE_MARKER"
  | "MISORDERED_MARKER"
  | "MALFORMED_HASH_PREFIX"
  | "MISSING_LAST_CHANGE"
  | "DUPLICATE_LAST_CHANGE";

export type GraceMarkupIssue = {
  path: string;
  code: GraceMarkupIssueCode;
  message: string;
};

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
        files.push(toPosixPath(relative(root, absolute)));
      }
    }
  };

  for (const sourceRoot of GOVERNED_ROOTS) {
    const absolute = resolve(root, sourceRoot);
    if (existsSync(absolute)) {
      visit(absolute);
    }
  }
  return files.sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countCommentMarker(text: string, marker: string): number {
  return Array.from(text.matchAll(new RegExp(`^\\s*//\\s+${escapeRegExp(marker)}\\s*$`, "gm")))
    .length;
}

function countLastChangeComments(text: string): number {
  return Array.from(text.matchAll(/^\s*\/\/\s+LAST_CHANGE:/gm)).length;
}

function validateGovernedFile(root: string, path: string): GraceMarkupIssue[] {
  const issues: GraceMarkupIssue[] = [];
  const text = readFileSync(resolve(root, path), "utf8");
  const expectedHeader = `// FILE: ${path}`;

  if (!new RegExp(`^${escapeRegExp(expectedHeader)}$`, "m").test(text)) {
    issues.push({
      path,
      code: "MISSING_FILE_HEADER",
      message: `expected exact header ${JSON.stringify(expectedHeader)}`,
    });
  }
  if (MALFORMED_HASH_PREFIX_PATTERN.test(text)) {
    issues.push({
      path,
      code: "MALFORMED_HASH_PREFIX",
      message: "semantic metadata contains an embedded hashline read prefix",
    });
  }

  for (const [start, end] of REQUIRED_MARKER_PAIRS) {
    const startCount = countCommentMarker(text, start);
    const endCount = countCommentMarker(text, end);
    if (startCount === 0) {
      issues.push({ path, code: "MISSING_MARKER", message: `missing ${start}` });
    } else if (startCount > 1) {
      issues.push({
        path,
        code: "DUPLICATE_MARKER",
        message: `${start} appears ${startCount} times`,
      });
    }
    if (endCount === 0) {
      issues.push({ path, code: "MISSING_MARKER", message: `missing ${end}` });
    } else if (endCount > 1) {
      issues.push({ path, code: "DUPLICATE_MARKER", message: `${end} appears ${endCount} times` });
    }
    const startLine = text.search(new RegExp(`^\\s*//\\s+${escapeRegExp(start)}\\s*$`, "m"));
    const endLine = text.search(new RegExp(`^\\s*//\\s+${escapeRegExp(end)}\\s*$`, "m"));
    if (startCount === 1 && endCount === 1 && startLine > endLine) {
      issues.push({ path, code: "MISORDERED_MARKER", message: `${start} appears after ${end}` });
    }
  }

  const lastChangeCount = countLastChangeComments(text);
  if (lastChangeCount === 0) {
    issues.push({
      path,
      code: "MISSING_LAST_CHANGE",
      message: "CHANGE_SUMMARY has no LAST_CHANGE",
    });
  } else if (lastChangeCount > 1) {
    issues.push({
      path,
      code: "DUPLICATE_LAST_CHANGE",
      message: `expected one LAST_CHANGE, found ${lastChangeCount}`,
    });
  }
  return issues;
}

export function collectGraceMarkupIssues(root = process.cwd()): GraceMarkupIssue[] {
  const normalizedRoot = resolve(root);
  const exceptions = new Set<string>(GRACE_MARKUP_EXCEPTIONS);
  const issues: GraceMarkupIssue[] = [];

  for (const exception of exceptions) {
    if (!existsSync(resolve(normalizedRoot, exception))) {
      issues.push({
        path: exception,
        code: "MISSING_EXPECTED_FILE",
        message: "documented GRACE markup exception does not exist",
      });
    }
  }

  for (const path of collectSourceFiles(normalizedRoot)) {
    if (!exceptions.has(path)) {
      issues.push(...validateGovernedFile(normalizedRoot, path));
    }
  }
  return issues.sort((left, right) =>
    left.path === right.path
      ? left.code.localeCompare(right.code)
      : left.path.localeCompare(right.path),
  );
}

export function checkGraceMarkup(root = process.cwd()): number {
  const issues = collectGraceMarkupIssues(root);
  if (issues.length === 0) {
    console.log("✓ GRACE file-local markup check passed.");
    return 0;
  }

  console.error(`✗ GRACE file-local markup check failed with ${issues.length} issue(s):`);
  for (const issue of issues) {
    console.error(`  ${issue.path} [${issue.code}] ${issue.message}`);
  }
  return 1;
}

if (import.meta.main) {
  process.exitCode = checkGraceMarkup();
}
