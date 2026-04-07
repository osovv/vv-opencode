// FILE: src/commands/upgrade.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Check npm registry for the latest vvoc version and offer in-place upgrade with changelog.
//   SCOPE: npm registry query, version comparison, changelog fetching, and user prompts.
//   DEPENDS: [citty]
//   LINKS: [M-CLI-UPGRADE]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Upgrade command definition for vvoc.
//   fetchLatestVersion - Query npm registry for latest version.
//   fetchChangelog - Fetch changelog from npm registry.
//   printUpgradeStatus - Print up-to-date or upgrade available message.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.0 - Initial GRACE implementation for upgrade command.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";

const PACKAGE_NAME = "@osovv/vv-opencode";
const NPM_REGISTRY = "https://registry.npmjs.org";

export default defineCommand({
  meta: {
    name: "upgrade",
    description: "Check for and perform upgrades.",
  },
  async run() {
    // START_BLOCK_RUN_UPGRADE
    try {
      const latestVersion = await fetchLatestVersion();
      const currentVersion = await getCurrentVersion();

      if (!latestVersion) {
        console.error("NETWORK_ERROR: Could not reach npm registry");
        process.exitCode = 1;
        return;
      }

      if (latestVersion === currentVersion) {
        console.log(`Already at latest version: ${currentVersion}`);
        return;
      }

      console.log(`Current version: ${currentVersion}`);
      console.log(`Latest version: ${latestVersion}`);
      console.log("Upgrade available!");

      const changelog = await fetchChangelog(currentVersion, latestVersion);
      if (changelog) {
        console.log("\n--- Changelog ---");
        console.log(changelog);
      }

      console.log("\nTo upgrade, run:");
      console.log(`  npm install -g ${PACKAGE_NAME}@${latestVersion}`);
    } catch (err) {
      if (err instanceof Error && err.message === "NETWORK_ERROR") {
        console.error("NETWORK_ERROR: Could not reach npm registry");
        process.exitCode = 1;
      } else if (err instanceof Error && err.message === "ALREADY_LATEST") {
        console.log("Already at latest version");
      } else {
        console.error("Upgrade check failed:", err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    }
    // END_BLOCK_RUN_UPGRADE
  },
});

export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const url = `${NPM_REGISTRY}/${encodeURIComponent(PACKAGE_NAME)}/latest`;
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

export async function fetchChangelog(
  _fromVersion: string,
  _toVersion: string,
): Promise<string | null> {
  try {
    const url = `${NPM_REGISTRY}/${encodeURIComponent(PACKAGE_NAME)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      versions?: Record<string, { description?: string }>;
      "dist-tags"?: { latest: string };
    };

    const latest = data["dist-tags"]?.latest;
    if (!latest || !data.versions) {
      return null;
    }

    const versionData = data.versions[latest];
    return versionData?.description ?? null;
  } catch {
    return null;
  }
}

export function printUpgradeStatus(currentVersion: string, latestVersion: string): void {
  if (currentVersion === latestVersion) {
    console.log(`Already at latest version: ${currentVersion}`);
  } else {
    console.log(`Update available: ${currentVersion} -> ${latestVersion}`);
  }
}

async function getCurrentVersion(): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("path");
  const packageJsonPath = resolve(process.cwd(), "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: string };
  return packageJson.version ?? "0.0.0";
}
