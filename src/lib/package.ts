// FILE: src/lib/package.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide runtime access to the vv-opencode package identity and installed version.
//   SCOPE: Package name constant, package.json version loading, and pinned package specifier construction.
//   DEPENDS: [node:fs]
//   LINKS: [M-CLI-CONFIG, M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PACKAGE_NAME - Canonical npm package name used in config and CLI output.
//   PACKAGE_VERSION - Canonical package version loaded from package.json.
//   getPackageVersionSync - Returns the current package version synchronously.
//   getPackageVersion - Lazily loads and memoizes the current package version.
//   getPinnedPackageSpecifier - Builds the package@version specifier written into OpenCode config.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.3.0 - Added a synchronous package version export for version-pinned schema URLs.]
// END_CHANGE_SUMMARY

import { readFileSync } from "node:fs";

export const PACKAGE_NAME = "@osovv/vv-opencode";
export const PACKAGE_VERSION = loadPackageVersionSync();

export function getPackageVersionSync(): string {
  return PACKAGE_VERSION;
}

export async function getPackageVersion(): Promise<string> {
  return PACKAGE_VERSION;
}

export async function getPinnedPackageSpecifier(): Promise<string> {
  return `${PACKAGE_NAME}@${await getPackageVersion()}`;
}

function loadPackageVersionSync(): string {
  // START_BLOCK_READ_PACKAGE_JSON
  const packageJsonUrl = new URL("../../package.json", import.meta.url);
  const packageJsonText = readFileSync(packageJsonUrl, "utf8");
  const packageJson = JSON.parse(packageJsonText) as { version?: unknown };

  if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
    throw new Error("package.json is missing a valid version");
  }

  // END_BLOCK_READ_PACKAGE_JSON
  return packageJson.version.trim();
}
