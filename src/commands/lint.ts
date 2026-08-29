// FILE: src/commands/lint.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Lint .vvoc spec-package XML artifacts (spec.xml, plan.xml, design-context.xml) with lifecycle-aware severity and stable exit codes.
//   SCOPE: Target resolution for a file, package directory, or specs tree; package grouping with cross-file sibling spec inputs; archive skipping with a visible count unless --archive; cache-backed lint runs; text and JSON output; exit code 0 without errors, 1 with errors, --strict escalating warnings.
//   DEPENDS: [citty, node:fs/promises, node:path, src/lib/spec-lint.ts, src/lib/spec-lint-cache.ts]
//   LINKS: [M-CLI-COMMANDS, M-SPEC-LINT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LintCommandOptions - Core lint-run options shared by the CLI and tests.
//   LintArtifactResult - One artifact's verdict plus its cache-hit flag.
//   LintRunResult - Structured result of one lint run over resolved targets.
//   ARTIFACT_FILE_NAMES - Recognized spec-package artifact file names.
//   DEFAULT_LINT_TARGET - Default lint target path (.vvoc/specs).
//   collectLintTargets - Resolve a path into package groups plus an archive skip count.
//   runLint - Execute the lint run over resolved targets through the cache.
//   renderLintReport - Render the text report for a lint run result.
//   computeLintExitCode - Map a run result to the stable exit-code contract.
//   default - vvoc lint command definition.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SPEC-IDENTITY-LINT - Initial command: file/package/tree targets, lifecycle-aware severity, archive skip, cache integration, strict/json flags.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  isSpecArchivePath,
  LINT_VERSION,
  type SpecLintArtifactInput,
  type SpecLintVerdict,
} from "../lib/spec-lint.js";
import { createSpecLintCache } from "../lib/spec-lint-cache.js";

// START_BLOCK_TYPES
export const ARTIFACT_FILE_NAMES = ["spec.xml", "plan.xml", "design-context.xml"] as const;

export interface LintCommandOptions {
  /** File, package directory, or specs tree to lint. Defaults to .vvoc/specs. */
  target: string;
  /** Include archived packages instead of skipping them. */
  includeArchive: boolean;
  /** Escalate warnings to exit failure. */
  strict: boolean;
  /** Bypass the lint cache entirely. */
  noCache: boolean;
}

export interface LintArtifactResult {
  verdict: SpecLintVerdict;
  cached: boolean;
}

export interface LintRunResult {
  lintVersion: number;
  target: string;
  skippedArchived: number;
  packages: Array<{ dir: string; artifacts: LintArtifactResult[] }>;
}

export const DEFAULT_LINT_TARGET = ".vvoc/specs";
// END_BLOCK_TYPES

// START_BLOCK_TARGET_RESOLUTION
async function walkXmlArtifacts(
  root: string,
  base: string,
  found: Array<{ path: string; archived: boolean }>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkXmlArtifacts(full, base, found);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!(ARTIFACT_FILE_NAMES as readonly string[]).includes(entry.name)) continue;
    const relativePath = relative(base, full).replace(/\\/g, "/");
    found.push({ path: full, archived: isSpecArchivePath(relativePath) });
  }
}

/**
 * Resolve a lint target into package groups. A file target becomes its own
 * group (plus the sibling spec as a cross-file input for plan targets) with
 * the requested file marked as the reporting primary; a directory target
 * walks recursively and groups artifacts by containing directory. Archived
 * files are counted and skipped unless included explicitly.
 */
export async function collectLintTargets(
  target: string,
  includeArchive: boolean,
): Promise<{
  groups: Array<{ dir: string; files: string[]; primary?: string }>;
  skippedArchived: number;
}> {
  const absolute = resolve(target);
  let targetStat;
  try {
    targetStat = await stat(absolute);
  } catch {
    throw new Error(`lint target not found: ${target}`);
  }

  if (targetStat.isFile()) {
    const fileName = absolute.split(/[/\\]/).pop() ?? "";
    if (!(ARTIFACT_FILE_NAMES as readonly string[]).includes(fileName)) {
      throw new Error(
        `not a spec-package artifact: ${fileName} (expected ${ARTIFACT_FILE_NAMES.join(", ")})`,
      );
    }
    const files = [absolute];
    if (fileName === "plan.xml") {
      const sibling = join(dirname(absolute), "spec.xml");
      try {
        await stat(sibling);
        files.push(sibling);
      } catch {
        // Missing sibling degrades to the engine's spec-missing warning.
      }
    }
    return {
      groups: [{ dir: dirname(absolute), files, primary: absolute.replace(/\\/g, "/") }],
      skippedArchived: 0,
    };
  }

  const found: Array<{ path: string; archived: boolean }> = [];
  await walkXmlArtifacts(absolute, absolute, found);

  const groups = new Map<string, string[]>();
  let skippedArchived = 0;
  for (const item of found) {
    if (item.archived && !includeArchive) {
      skippedArchived++;
      continue;
    }
    const dir = dirname(item.path);
    const bucket = groups.get(dir) ?? [];
    bucket.push(item.path);
    groups.set(dir, bucket);
  }

  return {
    groups: [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([dir, files]) => ({ dir, files })),
    skippedArchived,
  };
}
// END_BLOCK_TARGET_RESOLUTION

// START_BLOCK_RUN
async function readArtifactInputs(files: string[]): Promise<SpecLintArtifactInput[]> {
  const inputs: SpecLintArtifactInput[] = [];
  for (const file of files.sort()) {
    try {
      const content = await readFile(file, "utf8");
      inputs.push({ file: file.replace(/\\/g, "/"), content });
    } catch {
      // Unreadable files degrade to an explicit finding through the engine's unknown path.
      inputs.push({ file: file.replace(/\\/g, "/"), content: "" });
    }
  }
  return inputs;
}

/** Execute one lint run over resolved targets through the content-addressed cache. */
export async function runLint(
  options: LintCommandOptions,
  cacheRoot?: string,
): Promise<LintRunResult> {
  const cache = await createSpecLintCache({ cacheRoot, bypass: options.noCache });
  const { groups, skippedArchived } = await collectLintTargets(
    options.target,
    options.includeArchive,
  );

  const packages: LintRunResult["packages"] = [];
  for (const group of groups) {
    const inputs = await readArtifactInputs(group.files);
    const result = await cache.lint(inputs);
    const byFile = new Map(result.verdicts.map((v) => [v.file, v]));
    const reportFiles = group.primary
      ? group.files.filter((file) => file.replace(/\\/g, "/") === group.primary)
      : group.files;
    const artifacts: LintArtifactResult[] = reportFiles
      .map((file) => file.replace(/\\/g, "/"))
      .filter((file) => byFile.has(file))
      .map((file) => ({ verdict: byFile.get(file)!, cached: result.hit }));
    packages.push({ dir: group.dir.replace(/\\/g, "/"), artifacts });
  }

  return { lintVersion: LINT_VERSION, target: options.target, skippedArchived, packages };
}
// END_BLOCK_RUN

// START_BLOCK_REPORT
export function renderLintReport(result: LintRunResult, strict: boolean): string {
  const lines: string[] = [];
  let artifacts = 0;
  let errors = 0;
  let warnings = 0;

  for (const pkg of result.packages) {
    const pkgErrors = pkg.artifacts.reduce(
      (sum, a) => sum + a.verdict.findings.filter((f) => f.severity === "error").length,
      0,
    );
    const pkgWarnings = pkg.artifacts.reduce(
      (sum, a) => sum + a.verdict.findings.filter((f) => f.severity === "warning").length,
      0,
    );
    artifacts += pkg.artifacts.length;
    errors += pkgErrors;
    warnings += pkgWarnings;

    lines.push(
      `${pkg.dir}: ${pkg.artifacts.length} artifact(s), ${pkgErrors} error(s), ${pkgWarnings} warning(s)`,
    );
    for (const artifact of pkg.artifacts) {
      const name = artifact.verdict.file.split("/").pop() ?? artifact.verdict.file;
      if (artifact.verdict.findings.length === 0) {
        lines.push(`  ${name}: OK${artifact.cached ? " (cached)" : ""}`);
        continue;
      }
      lines.push(`  ${name}:${artifact.cached ? " (cached)" : ""}`);
      for (const finding of artifact.verdict.findings) {
        lines.push(
          `    ${artifact.verdict.file}:${finding.line} ${finding.severity} [${finding.rule}]: ${finding.message}`,
        );
      }
    }
  }

  if (result.skippedArchived > 0) {
    lines.push(
      `Skipped ${result.skippedArchived} archived artifact(s); use --archive to include them.`,
    );
  }

  const fail = errors > 0 || (strict && warnings > 0);
  lines.push(
    `${artifacts} artifact(s) checked: ${errors} error(s), ${warnings} warning(s) — ${fail ? "FAIL" : "OK"}${strict ? " (strict)" : ""}`,
  );
  return lines.join("\n");
}

export function computeLintExitCode(result: LintRunResult, strict: boolean): 0 | 1 {
  const hasErrors = result.packages.some((pkg) =>
    pkg.artifacts.some((a) => a.verdict.findings.some((f) => f.severity === "error")),
  );
  if (hasErrors) return 1;
  if (strict) {
    const hasWarnings = result.packages.some((pkg) =>
      pkg.artifacts.some((a) => a.verdict.findings.some((f) => f.severity === "warning")),
    );
    if (hasWarnings) return 1;
  }
  return 0;
}
// END_BLOCK_REPORT

// defineCommand wrapper: the run body is the RUN_LINT_COMMAND block below
export default defineCommand({
  meta: {
    name: "lint",
    description: "Lint .vvoc spec-package artifacts (spec.xml, plan.xml, design-context.xml).",
  },
  args: {
    path: {
      type: "positional",
      description: `File, package directory, or specs tree to lint (default: ${DEFAULT_LINT_TARGET})`,
      fallback: DEFAULT_LINT_TARGET,
    },
    strict: {
      type: "boolean",
      default: false,
      description: "Fail on warnings, not only errors.",
    },
    format: {
      type: "enum",
      options: ["text", "json"],
      default: "text",
      description: "Output format.",
    },
    "no-cache": {
      type: "boolean",
      default: false,
      description: "Bypass the content-addressed lint cache.",
    },
    archive: {
      type: "boolean",
      default: false,
      description: "Include archived packages instead of skipping them.",
    },
  },
  async run({ args }) {
    // START_BLOCK_RUN_LINT_COMMAND
    const options: LintCommandOptions = {
      target: typeof args.path === "string" && args.path ? args.path : DEFAULT_LINT_TARGET,
      includeArchive: args.archive === true,
      strict: args.strict === true,
      noCache: args["no-cache"] === true,
    };

    const result = await runLint(options);
    const strict = options.strict;

    if (args.format === "json") {
      console.log(
        JSON.stringify(
          {
            lintVersion: result.lintVersion,
            target: result.target,
            ok: computeLintExitCode(result, strict) === 0,
            strict,
            skippedArchived: result.skippedArchived,
            packages: result.packages.map((pkg) => ({
              dir: pkg.dir,
              artifacts: pkg.artifacts.map((a) => ({
                file: a.verdict.file,
                kind: a.verdict.kind,
                ok: a.verdict.ok,
                cached: a.cached,
                findings: a.verdict.findings,
              })),
            })),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(renderLintReport(result, strict));
    }

    process.exitCode = computeLintExitCode(result, strict);
    // END_BLOCK_RUN_LINT_COMMAND
  },
});
