#!/usr/bin/env bun
// FILE: scripts/release-check.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify release consistency: package name, version, schema $id, schema config format const, CHANGELOG.md presence, and latest changelog entry summary gate.
//   SCOPE: Reads package.json, schemas/vvoc/v3.json, and CHANGELOG.md; validates that schema $id matches expected CDN URL, that schema config format const is correct, that CHANGELOG.md exists with valid content, and that the latest release block has a valid ### Summary section.
//   DEPENDS: [node:fs, scripts/release-summary]
//   LINKS: [M-RELEASE-AUTOMATION, VF-RELEASE-AUTOMATION]
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   collectReleaseConsistencyErrors - Returns all package, schema, and changelog summary consistency errors for tests and main.
//   main - Reads release files, prints consistency errors, and exits nonzero on failure.
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.0 - Added latest changelog summary validation to release consistency checks.]
// END_CHANGE_SUMMARY

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateLatestChangelogSummary } from "./release-summary.ts";

const PKG_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("../schemas/vvoc/v3.json", import.meta.url));
const CHANGELOG_PATH = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));

const EXPECTED_PACKAGE_NAME = "@osovv/vv-opencode";
const EXPECTED_SCHEMA_CONST = 3;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CHANGELOG_VERSION_HEADER = /^##\s+/m;

interface PackageJson {
  name?: string;
  version?: string;
}

interface SchemaJson {
  $id?: string;
  properties?: {
    version?: { const?: number };
  };
}

function readJson<T>(path: string, label: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    console.error(`✗ Failed to read or parse ${label}: ${err}`);
    process.exit(1);
  }
}

/** Inputs required to validate release consistency. */
export interface ReleaseConsistencyInputs {
  /** Parsed package.json content. */
  pkg: PackageJson;
  /** Parsed vvoc schema JSON content. */
  schema: SchemaJson;
  /** Raw CHANGELOG.md text, or null when missing. */
  changelogText: string | null;
}

/**
 * Returns all release consistency errors without exiting the process.
 * Validates package identity/version, schema $id, schema const, changelog presence, and latest summary.
 */
export function collectReleaseConsistencyErrors(input: ReleaseConsistencyInputs): string[] {
  const errors: string[] = [];

  // Validate package name
  if (input.pkg.name !== EXPECTED_PACKAGE_NAME) {
    errors.push(
      `package.json name is "${input.pkg.name ?? ""}", expected "${EXPECTED_PACKAGE_NAME}"`,
    );
  }

  // Validate package version
  if (!input.pkg.version || typeof input.pkg.version !== "string" || !input.pkg.version.trim()) {
    errors.push(`package.json version is missing or invalid: "${input.pkg.version ?? ""}"`);
  } else if (!SEMVER_PATTERN.test(input.pkg.version.trim())) {
    errors.push(`package.json version is not a valid semver string: "${input.pkg.version}"`);
  }

  const version = input.pkg.version?.trim() ?? "";
  const expectedSchemaId = `https://cdn.jsdelivr.net/npm/${EXPECTED_PACKAGE_NAME}@${version}/schemas/vvoc/v3.json`;

  // Validate schema $id
  if (!input.schema.$id) {
    errors.push("schemas/vvoc/v3.json is missing $id");
  } else if (input.schema.$id !== expectedSchemaId) {
    errors.push(
      `schemas/vvoc/v3.json $id is "${input.schema.$id}", expected "${expectedSchemaId}"`,
    );
  }

  // Validate schema properties.version.const
  const versionConst = input.schema.properties?.version?.const;
  if (versionConst === undefined || versionConst === null) {
    errors.push("schemas/vvoc/v3.json properties.version.const is missing");
  } else if (versionConst !== EXPECTED_SCHEMA_CONST) {
    errors.push(
      `schemas/vvoc/v3.json properties.version.const is ${String(versionConst)}, expected ${EXPECTED_SCHEMA_CONST}`,
    );
  }

  // Validate CHANGELOG.md
  if (!input.changelogText) {
    errors.push("CHANGELOG.md is missing or empty");
  } else if (!CHANGELOG_VERSION_HEADER.test(input.changelogText)) {
    errors.push("CHANGELOG.md contains no version headers (expected ## [version] format)");
  } else {
    const summary = validateLatestChangelogSummary(input.changelogText);
    if (!summary.ok) {
      errors.push(`CHANGELOG.md latest release summary is invalid: ${summary.reason}`);
    }
  }

  return errors;
}

function exitWithErrors(errors: string[]): void {
  console.error("\nRelease consistency check FAILED:\n");
  for (const err of errors) {
    console.error(`  ✗ ${err}`);
  }
  process.exit(1);
}

/** Runs the release consistency check as a CLI command. */
function main(): void {
  const pkg = readJson<PackageJson>(PKG_PATH, "package.json");
  const schema = readJson<SchemaJson>(SCHEMA_PATH, "schemas/vvoc/v3.json");

  let changelogText: string | null = null;
  try {
    changelogText = readFileSync(CHANGELOG_PATH, "utf8");
  } catch {
    // File doesn't exist — handled in collectReleaseConsistencyErrors.
  }

  const errors = collectReleaseConsistencyErrors({ pkg, schema, changelogText });
  if (errors.length > 0) exitWithErrors(errors);

  console.log(`\n✓ Release consistency check passed: ${EXPECTED_PACKAGE_NAME}@${pkg.version?.trim() ?? ""}\n`);
}

if (import.meta.main) main();
