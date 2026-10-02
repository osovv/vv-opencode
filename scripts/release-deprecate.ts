#!/usr/bin/env bun
// FILE: scripts/release-deprecate.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deprecate every superseded stable v2 release of @osovv/vv-opencode on npm while leaving the current latest v2 untouched.
//   SCOPE: Reads published versions and dist-tags, selects stable v2 versions older than the kept release, and either prints the plan (default) or applies authenticated `npm deprecate` commands; never publishes, tags, or mutates repository files.
//   DEPENDS: [node:child_process, node:process]
//   LINKS: [M-RELEASE-AUTOMATION, V-M-RELEASE-AUTOMATION]
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PACKAGE_NAME - npm package whose superseded versions are deprecated.
//   REPO_URL - Public repository used in the deprecation hint.
//   STABLE_V2 - Matches a stable v2 semantic version.
//   compareStableVersions - Compares two stable x.y.z versions numerically.
//   parseVersionList - Parses the JSON version list returned by `npm view`.
//   parseDistTags - Parses the JSON dist-tag map returned by `npm view`.
//   buildDeprecationMessage - Builds the deprecation message pointing at the kept release.
//   selectSupersededVersions - Selects stable v2 versions below the kept release.
//   runNpm - Runs one read-only or mutating npm command and returns captured stdout.
//   assertAuthenticated - Fails early when npm has no authenticated identity.
//   applyDeprecations - Runs `npm deprecate` for each selected version.
//   main - Parses flags, resolves the kept release, prints the plan, and applies it only when requested.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial dry-run-first deprecation of superseded stable v2 releases.]
// END_CHANGE_SUMMARY

import { execFileSync } from "node:child_process";
import { argv, exit } from "node:process";

const PACKAGE_NAME = "@osovv/vv-opencode";
const REPO_URL = "https://github.com/osovv/vv-opencode";
const STABLE_V2 = /^2\.\d+\.\d+$/;

export function compareStableVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number(part));
  const rightParts = right.split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function parseVersionList(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout);
  if (Array.isArray(parsed)) return parsed.map((value) => String(value));
  if (typeof parsed === "string") return [parsed];
  throw new Error("unexpected `npm view versions` output");
}

export function parseDistTags(stdout: string): Record<string, string> {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("unexpected `npm view dist-tags` output");
  }
  const tags: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) tags[name] = String(value);
  return tags;
}

export function buildDeprecationMessage(keep: string): string {
  return `Deprecated: use ${PACKAGE_NAME}@${keep} instead. See ${REPO_URL}/releases/tag/v${keep}`;
}

export function selectSupersededVersions(versions: string[], keep: string): string[] {
  return versions
    .filter((version) => STABLE_V2.test(version) && compareStableVersions(version, keep) < 0)
    .sort(compareStableVersions);
}

function runNpm(args: string[], captured: boolean): string {
  return execFileSync("npm", args, {
    encoding: "utf8",
    stdio: captured ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function assertAuthenticated(): void {
  try {
    runNpm(["whoami"], true);
  } catch {
    throw new Error("npm is not authenticated; run `npm login` before applying deprecations");
  }
}

function applyDeprecations(versions: string[], message: string): void {
  for (const version of versions) {
    console.log(`Deprecating ${PACKAGE_NAME}@${version}`);
    runNpm(["deprecate", `${PACKAGE_NAME}@${version}`, message], false);
  }
}

function main(rawArgs: string[]): number {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    console.log(
      [
        `Usage: bun run release:deprecate [--apply] [--keep <version>]`,
        "",
        "  --apply          Apply npm deprecate instead of printing the plan.",
        "  --keep <version> Keep an explicit stable v2 version instead of the latest dist-tag.",
        "",
        "Deprecates every stable v2.* release below the kept version.",
      ].join("\n"),
    );
    return 0;
  }

  const apply = rawArgs.includes("--apply");
  const keepIndex = rawArgs.indexOf("--keep");
  const keepOverride = keepIndex >= 0 ? rawArgs[keepIndex + 1] : undefined;

  const distTags = parseDistTags(runNpm(["view", PACKAGE_NAME, "dist-tags", "--json"], true));
  const keep = keepOverride ?? distTags.latest ?? "";
  if (!STABLE_V2.test(keep)) {
    throw new Error(`latest dist-tag is not a stable v2 version: ${JSON.stringify(keep)}`);
  }

  const versions = parseVersionList(runNpm(["view", PACKAGE_NAME, "versions", "--json"], true));
  const targets = selectSupersededVersions(versions, keep);

  console.log(`Package: ${PACKAGE_NAME}`);
  console.log(`Keeping: ${keep}`);
  if (targets.length === 0) {
    console.log("No superseded stable v2 versions to deprecate.");
    return 0;
  }

  console.log(`Will deprecate ${targets.length} version(s): ${targets.join(", ")}`);
  console.log(`Message: ${buildDeprecationMessage(keep)}`);

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to deprecate.");
    return 0;
  }

  assertAuthenticated();
  applyDeprecations(targets, buildDeprecationMessage(keep));
  return 0;
}

if (import.meta.main) {
  try {
    exit(main(argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exit(1);
  }
}
