// FILE: src/lib/package.ts
// VERSION: 0.2.5
// START_MODULE_CONTRACT
//   PURPOSE: Provide runtime access to the vv-opencode package identity and installed version.
//   SCOPE: Package name constant, lazy package.json version loading, and pinned package specifier construction.
//   DEPENDS: [node:fs/promises]
//   LINKS: [M-CLI-CONFIG, M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PACKAGE_NAME - Canonical npm package name used in config and CLI output.
//   getPackageVersion - Lazily loads and memoizes the current package version.
//   getPinnedPackageSpecifier - Builds the package@version specifier written into OpenCode config.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.5 - Added GRACE runtime markup around package identity helpers for easier navigation.]
// END_CHANGE_SUMMARY

import { readFile } from "node:fs/promises";

export const PACKAGE_NAME = "@osovv/vv-opencode";

let packageVersionPromise: Promise<string> | undefined;

export async function getPackageVersion(): Promise<string> {
  packageVersionPromise ??= loadPackageVersion();
  return packageVersionPromise;
}

export async function getPinnedPackageSpecifier(): Promise<string> {
  return `${PACKAGE_NAME}@${await getPackageVersion()}`;
}

async function loadPackageVersion(): Promise<string> {
  // START_BLOCK_READ_PACKAGE_JSON
  const packageJsonUrl = new URL("../../package.json", import.meta.url);
  const packageJsonText = await readFile(packageJsonUrl, "utf8");
  const packageJson = JSON.parse(packageJsonText) as { version?: unknown };

  if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
    throw new Error("package.json is missing a valid version");
  }

  // END_BLOCK_READ_PACKAGE_JSON
  return packageJson.version.trim();
}
