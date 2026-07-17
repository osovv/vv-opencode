#!/usr/bin/env bun
// FILE: scripts/release-bump.ts
// VERSION: 1.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Prepare and push an exact-SHA release commit, wait for CI-gated npm publication, then create the annotated tag and GitHub Release with the authenticated local user.
//   SCOPE: Validates clean worktree, accepts npm version args (patch/minor/major/prerelease/explicit semver), generates changelog entry from git history via conventional-changelog, collects commit metadata plus full per-commit diffs, generates a mandatory AI release changelog summary with OpenCode --pure run and retry/validation, updates package.json and schema $id, runs release:check, commits, pushes the current branch, dispatches publish.yml with the release version and commit SHA, waits for CI success, retries npm metadata and verifies gitHead, then creates and pushes the annotated tag plus GitHub Release locally.
//   DEPENDS: [node:fs, node:child_process, gh CLI, scripts/release-summary.ts]
//   LINKS: [M-RELEASE-AUTOMATION, VF-RELEASE-AUTOMATION]
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   parseNpmVersionArgs - Validates supported npm version target arguments without shell interpolation.
//   readPackageVersion - Reads the package version from package.json.
//   run - Runs a command via execFileSync with inherited stdio and exits on failure.
//   runCapture - Runs a command and captures stdout as a string.
//   runCaptureRetryable - Captures stdout while surfacing command failures to bounded retry logic.
//   runOpencodeSummary - Invokes opencode --pure run with stdin prompt for one summary attempt.
//   sleepMs - Blocks synchronously for the given milliseconds between retry attempts.
//   generateChangelog - Runs conventional-changelog as subprocess to generate entry from git history.
//   prependToChangelog - Prepends a changelog entry to CHANGELOG.md, creating the file if missing.
//   updateSchemaId - Patches only the hosted schema $id text for the new package version.
//   assertOnlyReleaseFilesChanged - Ensures the bump leaves only package.json, schema, and CHANGELOG changes before commit.
//   assertTagDoesNotExist - Verifies the release tag does not already exist.
//   getCurrentBranchName - Returns the current branch name and rejects detached HEAD release bumps.
//   dispatchVerifiedPublishWorkflow - Pushes only the release commit branch and returns the exact-SHA publish workflow run URL.
//   parseWorkflowRunId - Extracts a GitHub Actions run ID from gh workflow run output.
//   waitForPublishWorkflow - Waits for the exact workflow run and fails closed unless it succeeds.
//   extractReleaseChangelogEntry - Extracts one version block for GitHub Release notes.
//   finalizePublishedRelease - Retries npm gitHead propagation, then creates and pushes the local annotated tag and GitHub Release.
//   main - Runs the guarded release bump through CI publication and authenticated local release finalization.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Added bounded npm metadata retry before post-CI tag finalization.]
//   LAST_CHANGE: [DIRECT-FIX - Finalized tags and GitHub Releases locally after CI because GITHUB_TOKEN cannot tag commits containing workflow changes.]
//   LAST_CHANGE: [DIRECT-FIX - Moved tag creation and npm publication behind exact-SHA CI verification instead of pushing a tag before tests.]
//   LAST_CHANGE: [v1.1.0 - Updated for full per-commit diff context in release summaries plus mandatory summary generation.]
// END_CHANGE_SUMMARY

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  buildReleaseSummaryAgentConfig,
  collectReleaseCommitMetadata,
  generateReleaseSummaryWithRetries,
  injectSummaryIntoChangelogEntry,
  resolveReleaseSummaryOptions,
  type OpencodeRunRequest,
  type OpencodeRunResult,
} from "./release-summary.ts";

const PKG_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("../schemas/vvoc/v3.json", import.meta.url));
const CHANGELOG_PATH = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));

const PACKAGE_NAME = "@osovv/vv-opencode";
const ALLOWED_RELEASE_FILES = new Set(["package.json", "schemas/vvoc/v3.json", "CHANGELOG.md"]);
const CAPTURE_MAX_BUFFER = 128 * 1024 * 1024;
const PUBLISHED_METADATA_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
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

export type ReleaseCommandRunner = (
  command: string,
  args: string[],
  failureMessage: string,
) => string;

export type ReleaseSleeper = (milliseconds: number) => void;

export interface ReleaseWorkflowDispatchInput {
  branchName: string;
  version: string;
  commitSha: string;
}

export interface PublishedReleaseFinalizationInput {
  version: string;
  commitSha: string;
  tagName: string;
  changelogText: string;
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
    return execFileSync(command, args, { encoding: "utf8", maxBuffer: CAPTURE_MAX_BUFFER });
  } catch (err) {
    console.error(`\n✗ ${failureMessage}`);
    console.error(`  ${String(err)}`);
    process.exit(1);
  }
}

function runCaptureRetryable(command: string, args: string[], failureMessage: string): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", maxBuffer: CAPTURE_MAX_BUFFER });
  } catch (err) {
    throw new Error(`${failureMessage} ${String(err)}`);
  }
}

/** Runs opencode for one release summary attempt using stdin and JSONL output. */
function runOpencodeSummary(request: OpencodeRunRequest): OpencodeRunResult {
  const result = spawnSync(
    "opencode",
    [
      "--pure",
      "run",
      "--format",
      "json",
      "--agent",
      "release-summary",
      "--model",
      request.model,
      "Generate the required release changelog summary from stdin. Return only the <summary> envelope.",
    ],
    {
      encoding: "utf8",
      input: request.input,
      env: request.env,
      timeout: request.timeoutMs,
      maxBuffer: 1024 * 1024,
    },
  );

  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: typeof result.error === "object" && result.error !== null && "code" in result.error && result.error.code === "ETIMEDOUT",
    errorCode: typeof result.error === "object" && result.error && "code" in result.error ? String(result.error.code) : undefined,
  };
}

/** Sleeps synchronously between release summary retry attempts. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}


/**
 * Runs conventional-changelog as a subprocess to generate a changelog entry
 * from git history. Uses the conventionalcommits preset and generates for the
 * latest release (commits since last tag).
 * Returns the stdout output. Throws on subprocess failure.
 */
function generateChangelog(): string {
  return runCapture(
    "bun",
    ["x", "conventional-changelog", "-p", "conventionalcommits", "-r", "1"],
    "conventional-changelog failed. Release aborted."
  ).trim();
}

/**
 * Prepends the given changelog entry to CHANGELOG.md.
 * If the file does not exist, creates it with the entry as its full content.
 * Preserves existing content below the newly prepended entry.
 */
function prependToChangelog(entry: string): void {
  let existing = "";
  try {
    existing = readFileSync(CHANGELOG_PATH, "utf8").trim();
  } catch {
    // File does not exist yet — create from scratch.
  }
  const content = existing ? `${entry}\n\n${existing}` : `${entry}\n`;
  writeFileSync(CHANGELOG_PATH, content, "utf8");
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
    console.error("Commit or handle these files manually before preparing the release commit.");
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

function getCurrentBranchName(): string {
  const branchName = runCapture(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    "git rev-parse failed while detecting the current branch.",
  ).trim();

  if (!branchName || branchName === "HEAD") {
    console.error("✗ release:bump requires a checked-out branch. Detached HEAD is not supported.");
    process.exit(1);
  }

  return branchName;
}

export function dispatchVerifiedPublishWorkflow(
  input: ReleaseWorkflowDispatchInput,
  execute: ReleaseCommandRunner = run,
  capture: ReleaseCommandRunner = runCapture,
): string {
  execute(
    "git",
    ["push", "origin", input.branchName],
    `git push origin ${input.branchName} failed. The release commit exists locally but CI was not dispatched.`,
  );
  const workflowOutput = capture(
    "gh",
    [
      "workflow",
      "run",
      "publish.yml",
      "--ref",
      input.branchName,
      "-f",
      `version=${input.version}`,
      "-f",
      `commit_sha=${input.commitSha}`,
    ],
    `Failed to dispatch publish.yml. Retry with: gh workflow run publish.yml --ref ${input.branchName} -f version=${input.version} -f commit_sha=${input.commitSha}`,
  );
  const normalized = workflowOutput.trim();
  if (normalized) console.log(normalized);
  return normalized;
}

export function parseWorkflowRunId(workflowOutput: string): string {
  const match = workflowOutput.match(/\/actions\/runs\/(\d+)(?:\b|\/|$)/);
  if (!match?.[1]) {
    throw new Error(`Could not determine GitHub Actions run ID from: ${workflowOutput || "<empty output>"}`);
  }
  return match[1];
}

export function waitForPublishWorkflow(
  workflowRunId: string,
  execute: ReleaseCommandRunner = run,
): void {
  execute(
    "gh",
    ["run", "watch", workflowRunId, "--exit-status"],
    `Failed to watch publish.yml run ${workflowRunId}. CI may have failed or the local gh authentication may not support run watch; inspect it with: gh run view ${workflowRunId}. No release tag was created.`,
  );
}

export function extractReleaseChangelogEntry(changelogText: string, version: string): string {
  const lines = changelogText.split(/\r?\n/);
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const releaseHeader = new RegExp(
    `^##\\s+(?:<small>)?\\[?${escapedVersion}\\]?(?=\\s|\\(|<|$)`,
  );
  const start = lines.findIndex((line) => releaseHeader.test(line));
  if (start < 0) throw new Error(`CHANGELOG.md has no release entry for ${version}.`);

  const nextHeaderOffset = lines.slice(start + 1).findIndex((line) => line.startsWith("## "));
  const end = nextHeaderOffset < 0 ? lines.length : start + 1 + nextHeaderOffset;
  return lines.slice(start, end).join("\n").trim();
}

export function finalizePublishedRelease(
  input: PublishedReleaseFinalizationInput,
  execute: ReleaseCommandRunner = run,
  capture: ReleaseCommandRunner = runCaptureRetryable,
  sleep: ReleaseSleeper = sleepMs,
): void {
  let publishedSha = "";
  let lastCaptureError: unknown;
  for (let attempt = 0; attempt <= PUBLISHED_METADATA_RETRY_DELAYS_MS.length; attempt++) {
    try {
      publishedSha = capture(
        "npm",
        ["view", `${PACKAGE_NAME}@${input.version}`, "gitHead"],
        `Failed to verify ${PACKAGE_NAME}@${input.version} after CI publication.`,
      ).trim();
      lastCaptureError = undefined;
    } catch (error) {
      publishedSha = "";
      lastCaptureError = error;
    }

    if (publishedSha) break;
    const retryDelayMs = PUBLISHED_METADATA_RETRY_DELAYS_MS[attempt];
    if (retryDelayMs === undefined) {
      const detail = lastCaptureError ? ` Last error: ${String(lastCaptureError)}` : "";
      throw new Error(
        `${PACKAGE_NAME}@${input.version} did not expose gitHead after ${attempt + 1} attempts.${detail}`,
      );
    }
    console.log(`npm metadata is not available yet; retrying in ${retryDelayMs / 1_000}s...`);
    sleep(retryDelayMs);
  }

  if (publishedSha !== input.commitSha) {
    throw new Error(
      `${PACKAGE_NAME}@${input.version} gitHead is ${publishedSha || "missing"}, expected ${input.commitSha}.`,
    );
  }

  const releaseNotes = extractReleaseChangelogEntry(input.changelogText, input.version);
  execute(
    "git",
    ["tag", "-a", "-m", input.tagName, input.tagName, input.commitSha],
    `Failed to create local annotated tag ${input.tagName} after successful publication.`,
  );
  execute(
    "git",
    ["push", "origin", input.tagName],
    `Failed to push ${input.tagName}. The package is published and the tag exists locally.`,
  );
  execute(
    "gh",
    ["release", "create", input.tagName, "--verify-tag", "--title", input.tagName, "--notes", releaseNotes],
    `Failed to create GitHub Release ${input.tagName}. The package and tag already exist.`,
  );
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


  // START_BLOCK_GENERATE_CHANGELOG
  console.log("\nGenerating changelog entry...\n");
  let changelogEntry = generateChangelog();
  if (!changelogEntry) {
    const today = new Date().toISOString().slice(0, 10);
    changelogEntry = `## [${newVersion}] - ${today}\n\n_No user-facing changes._`;
  }

  // START_BLOCK_GENERATE_SUMMARY
  console.log("\nGenerating release summary with OpenCode...\n");
  const summaryOptions = resolveReleaseSummaryOptions(process.env);
  const commits = collectReleaseCommitMetadata(runCapture);
  const summary = generateReleaseSummaryWithRetries(
    runOpencodeSummary,
    { version: newVersion, changelogEntry, commits },
    summaryOptions,
    sleepMs,
  );
  changelogEntry = injectSummaryIntoChangelogEntry(changelogEntry, summary);
  console.log("Release summary generated and injected into changelog entry.");
  // END_BLOCK_GENERATE_SUMMARY

  prependToChangelog(changelogEntry);
  console.log("Changelog entry prepended to CHANGELOG.md");
  // END_BLOCK_GENERATE_CHANGELOG
  // START_BLOCK_UPDATE_SCHEMA_ID
  updateSchemaId(newVersion);
  // END_BLOCK_UPDATE_SCHEMA_ID

  // START_BLOCK_RUN_RELEASE_CHECK
  console.log("\nRunning release:check...\n");
  run("bun", ["run", "release:check"], "release:check failed after bump. Release aborted.");
  // END_BLOCK_RUN_RELEASE_CHECK

  // START_BLOCK_GIT_COMMIT
  assertOnlyReleaseFilesChanged();

  const branchName = getCurrentBranchName();
  const tagName = `v${newVersion}`;
  assertTagDoesNotExist(tagName);

  console.log("\nCreating release commit...\n");
  run("git", ["add", "package.json", "schemas/vvoc/v3.json", "CHANGELOG.md"], "git add failed.");
  run(
    "git",
    ["commit", "-m", `chore: bump version from ${currentVersion} to ${newVersion} with changelog`],
    "git commit failed. package.json and schema have been updated but may not be committed.",
  );
  const releaseCommitSha = runCapture("git", ["rev-parse", "HEAD"], "git rev-parse failed.").trim();
  // END_BLOCK_GIT_COMMIT

  // START_BLOCK_PUSH_AND_DISPATCH
  console.log("\nPushing release commit and dispatching verified publish workflow...\n");
  const workflowOutput = dispatchVerifiedPublishWorkflow({
    branchName,
    version: newVersion,
    commitSha: releaseCommitSha,
  });
  let workflowRunId: string;
  try {
    workflowRunId = parseWorkflowRunId(workflowOutput);
  } catch (error) {
    console.error(`\n✗ ${String(error)}`);
    console.error("  The release commit was pushed, but automatic CI monitoring could not start.");
    process.exit(1);
  }

  console.log(`\nWaiting for publish workflow run ${workflowRunId}...\n`);
  waitForPublishWorkflow(workflowRunId);
  // END_BLOCK_PUSH_AND_DISPATCH

  // START_BLOCK_FINALIZE_RELEASE
  console.log("\nCI publication succeeded. Creating tag and GitHub Release locally...\n");
  try {
    finalizePublishedRelease({
      version: newVersion,
      commitSha: releaseCommitSha,
      tagName,
      changelogText: readFileSync(CHANGELOG_PATH, "utf8"),
    });
  } catch (error) {
    console.error(`\n✗ Release finalization failed: ${String(error)}`);
    process.exit(1);
  }
  // END_BLOCK_FINALIZE_RELEASE

  console.log(`\n✓ Release ${tagName} published, tagged, and released.\n`);
  console.log(`  Git SHA: ${releaseCommitSha}`);
  console.log(`  Branch: ${branchName}`);
  console.log(`  Tag: ${tagName}\n`);
}

if (import.meta.main) main();
