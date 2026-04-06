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
  const packageJsonUrl = new URL("../../package.json", import.meta.url);
  const packageJsonText = await readFile(packageJsonUrl, "utf8");
  const packageJson = JSON.parse(packageJsonText) as { version?: unknown };

  if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
    throw new Error("package.json is missing a valid version");
  }

  return packageJson.version.trim();
}
