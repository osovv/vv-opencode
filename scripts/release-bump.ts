#!/usr/bin/env bun
// FILE: scripts/release-bump.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Wrapper around npm version --no-git-tag-version that patches schema $id, runs release checks, then creates a release commit and tag.
//   SCOPE: Validates clean worktree, accepts npm version args (patch/minor/major/prerelease/explicit semver), updates package.json and schema $id, runs release:check, commits, tags.
//   DEPENDS: [node:fs, node:child_process]
//   LINKS: [scripts/release-check.ts]
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   parseNpmVersionArgs - Validates supported npm version target arguments without shell interpolation.
//   updateSchemaId - Patches only the hosted schema $id text for the new package version.
//   assertOnlyReleaseFilesChanged - Ensures the bump leaves only package.json and schema changes before commit.
//   main - Runs the guarded release bump, consistency check, commit, and tag flow.
// END_MODULE_MAP

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("../schemas/vvoc/v3.json", import.meta.url));

const PACKAGE_NAME = "@osovv/vv-opencode";
const ALLOWED_RELEASE_FILES = new Set(["package.json", "schemas/vvoc/v3.json"]);
const RELEASE_TYPES = new Set([
  "major",
  "minor",
  "patch",
  "premajor",
  "preminor",
  "prepatch",
  "prerelease",
]);
const SEMVER_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SCHEMA_ID_PATTERN = /("\$id"\s*:\s*")https:\/\/cdn\.jsdelivr\.net\/npm\/@osovv\/vv-opencode@[^"/]+\/schemas\/vvoc\/v3\.json(")/;

interface PackageJson {
  version?: string;
}

interface SchemaJson {
  $id?: string;
}

function gitStatus(): string {
  try {
    return execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  } catch (err) {
    console.error(`✗ Failed to inspect git status: ${err}`);
    process.exit(1);
  }
}

function parseNpmVersionArgs(args: string[]): string[] {
  const bumpArg = args[0];

  if (!bumpArg) {
    console.error(
      "Usage: bun run release:bump <patch|minor|major|prerelease|prepatch|preminor|premajor|<semver>> [--preid <id>]\n",
    );
    process.exit(1);
  }

  if (!RELEASE_TYPES.has(bumpArg) && !SEMVER_PATTERN.test(bumpArg)) {
    console.error(`✗ Unsupported npm version target: ${bumpArg}`);
    process.exit(1);
  }

  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith("--preid=")) {
      continue;
    }
    if (arg === "--preid") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        console.error("✗ --preid requires a non-empty value.");
        process.exit(1);
      }
      index++;
      continue;
    }

    console.error(`✗ Unsupported npm version option: ${arg}`);
    console.error("  release:bump only forwards the version target plus optional --preid.");
    process.exit(1);
  }

  return args;
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as PackageJson;
  return pkg.version?.trim() ?? "";
}

function run(command: string, args: string[], failureMessage: string): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: "inherit" }) ?? "";
  } catch (err) {
    console.error(`\n✗ ${failureMessage}`);
    console.error(`  ${String(err)}`);
    process.exit(1);
  }
}

function runCapture(command: string, args: string[], failureMessage: string): string {
  try {
    return execFileSync(command, args, { encoding: "utf8" });
  } catch (err) {
    console.error(`\n✗ ${failureMessage}`);
    console.error(`  ${String(err)}`);
    process.exit(1);
  }
}

function updateSchemaId(newVersion: string): void {
  const expectedSchemaId = `https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}@${newVersion}/schemas/vvoc/v3.json`;
  const schemaText = readFileSync(SCHEMA_PATH, "utf8");
  let replacements = 0;

  const updatedSchemaText = schemaText.replace(SCHEMA_ID_PATTERN, (_match, prefix: string, suffix: string) => {
    replacements++;
    return `${prefix}${expectedSchemaId}${suffix}`;
  });

  if (replacements !== 1) {
    console.error(
      "✗ Could not update schema $id. Expected exactly one hosted vvoc schema URL in schemas/vvoc/v3.json.",
    );
    process.exit(1);
  }

  const schema = JSON.parse(updatedSchemaText) as SchemaJson;
  if (schema.$id !== expectedSchemaId) {
    console.error(`✗ Schema $id patch did not produce the expected URL: ${expectedSchemaId}`);
    process.exit(1);
  }

  writeFileSync(SCHEMA_PATH, updatedSchemaText, "utf8");
  console.log(`\nUpdated schema $id to: ${expectedSchemaId}`);
}

function assertOnlyReleaseFilesChanged(): void {
  const changedFiles = gitStatus()
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3));

  const unexpectedFiles = changedFiles.filter((path) => !ALLOWED_RELEASE_FILES.has(path));
  if (unexpectedFiles.length > 0) {
    console.error("✗ release:bump produced unexpected working tree changes:");
    for (const path of unexpectedFiles) {
      console.error(`  ${path}`);
    }
    console.error("Commit or handle these files manually before creating a release tag.");
    process.exit(1);
  }
}

function assertTagDoesNotExist(tagName: string): void {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tagName}`], {
      stdio: "ignore",
    });
    console.error(`✗ Tag ${tagName} already exists.`);
    process.exit(1);
  } catch {
    // Expected when the tag does not exist.
  }
}

function main(): void {
  const npmVersionArgs = parseNpmVersionArgs(process.argv.slice(2));

  // START_BLOCK_CHECK_CLEAN_WORKTREE
  const status = gitStatus();
  if (status.trim()) {
    console.error(
      "✗ Worktree is dirty. Commit or stash your changes before running release:bump.\n",
    );
    console.error("Uncommitted changes:\n");
    process.stderr.write(status);
    process.exit(1);
  }
  // END_BLOCK_CHECK_CLEAN_WORKTREE

  // Read current version
  const currentVersion = readPackageVersion();
  console.log(`Current version: ${currentVersion}`);

  // START_BLOCK_RUN_NPM_VERSION
  console.log(`\nRunning: npm version --no-git-tag-version ${npmVersionArgs.join(" ")}`);
  run("npm", ["version", "--no-git-tag-version", ...npmVersionArgs], "npm version failed. Aborting release bump.");
  // END_BLOCK_RUN_NPM_VERSION

  // Read new version
  const newVersion = readPackageVersion();
  if (!newVersion) {
    console.error("✗ Failed to read new version from package.json after bump.");
    process.exit(1);
  }
  console.log(`New version: ${newVersion}`);

  // START_BLOCK_UPDATE_SCHEMA_ID
  updateSchemaId(newVersion);
  // END_BLOCK_UPDATE_SCHEMA_ID

  // START_BLOCK_RUN_RELEASE_CHECK
  console.log("\nRunning release:check...\n");
  run("bun", ["run", "release:check"], "release:check failed after bump. Release aborted.");
  // END_BLOCK_RUN_RELEASE_CHECK

  // START_BLOCK_GIT_COMMIT_AND_TAG
  assertOnlyReleaseFilesChanged();

  const tagName = `v${newVersion}`;
  assertTagDoesNotExist(tagName);

  console.log("\nCreating release commit and tag...\n");
  run("git", ["add", "package.json", "schemas/vvoc/v3.json"], "git add failed.");
  run(
    "git",
    ["commit", "-m", `chore: bump version from ${currentVersion} to ${newVersion}`],
    "git commit failed. package.json and schema have been updated but may not be committed.",
  );
  run("git", ["tag", "-a", tagName, "-m", tagName], "git tag failed. Release commit was created without a tag.");
  // END_BLOCK_GIT_COMMIT_AND_TAG

  console.log(`\n✓ Release ${tagName} committed and tagged.\n`);
  console.log(`  Git SHA: ${runCapture("git", ["rev-parse", "HEAD"], "git rev-parse failed.").trim()}`);
  console.log(`  Tag: ${tagName}\n`);
  console.log("To publish:");
  console.log(`  git push && git push --tags\n`);
}

main();
