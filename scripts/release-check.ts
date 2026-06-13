#!/usr/bin/env bun
// FILE: scripts/release-check.ts
// VERSION: 1.0.0
//   PURPOSE: Verify release consistency: package name, version, schema $id, schema config format const, and CHANGELOG.md.
//   SCOPE: Reads package.json, schemas/vvoc/v3.json, and CHANGELOG.md; validates that schema $id matches expected CDN URL, that schema config format const is correct, and that CHANGELOG.md exists with valid content.
//   DEPENDS: [node:fs]
//   LINKS: []
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   readJson - Reads and parses a JSON file with a path-aware failure.
//   main - Validates package identity, package version, schema $id, vvoc config format version, and CHANGELOG.md.
// END_MODULE_MAP

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PKG_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("../schemas/vvoc/v3.json", import.meta.url));
const CHANGELOG_PATH = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));

const EXPECTED_PACKAGE_NAME = "@osovv/vv-opencode";
const EXPECTED_SCHEMA_CONST = 3;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CHANGELOG_VERSION_HEADER = /^##\s+\[/m;

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

function main(): void {
  const errors: string[] = [];

  const pkg = readJson<PackageJson>(PKG_PATH, "package.json");

  // Validate package name
  if (pkg.name !== EXPECTED_PACKAGE_NAME) {
    errors.push(
      `package.json name is "${pkg.name ?? ""}", expected "${EXPECTED_PACKAGE_NAME}"`,
    );
  }

  // Validate package version
  if (!pkg.version || typeof pkg.version !== "string" || !pkg.version.trim()) {
    errors.push(`package.json version is missing or invalid: "${pkg.version ?? ""}"`);
  } else if (!SEMVER_PATTERN.test(pkg.version.trim())) {
    errors.push(`package.json version is not a valid semver string: "${pkg.version}"`);
  }

  const schema = readJson<SchemaJson>(SCHEMA_PATH, "schemas/vvoc/v3.json");

  const version = pkg.version?.trim() ?? "";
  const expectedSchemaId = `https://cdn.jsdelivr.net/npm/${EXPECTED_PACKAGE_NAME}@${version}/schemas/vvoc/v3.json`;

  // Validate schema $id
  if (!schema.$id) {
    errors.push("schemas/vvoc/v3.json is missing $id");
  } else if (schema.$id !== expectedSchemaId) {
    errors.push(
      `schemas/vvoc/v3.json $id is "${schema.$id}", expected "${expectedSchemaId}"`,
    );
  }

  // Validate schema properties.version.const
  const versionConst = schema.properties?.version?.const;
  if (versionConst === undefined || versionConst === null) {
    errors.push("schemas/vvoc/v3.json properties.version.const is missing");
  } else if (versionConst !== EXPECTED_SCHEMA_CONST) {
    errors.push(
      `schemas/vvoc/v3.json properties.version.const is ${String(versionConst)}, expected ${EXPECTED_SCHEMA_CONST}`,
    );
  }

  // Validate CHANGELOG.md
  let changelogText: string | null = null;
  try {
    changelogText = readFileSync(CHANGELOG_PATH, "utf8");
  } catch {
    // File doesn't exist — handled below.
  }
  if (!changelogText) {
    errors.push("CHANGELOG.md is missing or empty");
  } else if (!CHANGELOG_VERSION_HEADER.test(changelogText)) {
    errors.push("CHANGELOG.md contains no version headers (expected ## [version] format)");
  }

  if (errors.length > 0) {
    console.error("\nRelease consistency check FAILED:\n");
    for (const err of errors) {
      console.error(`  ✗ ${err}`);
    }
    process.exit(1);
  }

  console.log(`\n✓ Release consistency check passed: ${EXPECTED_PACKAGE_NAME}@${version}\n`);
}

main();
