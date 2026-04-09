// FILE: src/commands/upgrade.ts
// VERSION: 0.5.0
// START_MODULE_CONTRACT
//   PURPOSE: Upgrade the global vvoc package by checking npm, installing the latest release with Bun, and triggering a fresh sync subprocess.
//   SCOPE: npm registry query, version comparison, best-effort changelog fetching, global Bun install, and post-install sync execution.
//   DEPENDS: [citty, src/lib/package.ts, Bun]
//   LINKS: [M-CLI-UPGRADE]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Upgrade command definition for vvoc.
//   runUpgradeFlow - Execute the full global upgrade and post-install sync flow.
//   buildInstallCommand - Build the Bun global install command for a specific version.
//   buildPostInstallSyncCommand - Build the fresh subprocess command for the default global sync flow.
//   fetchLatestVersion - Query npm registry for latest version.
//   fetchChangelog - Fetch changelog from npm registry.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.5.0 - Redesigned upgrade into a global-only Bun install flow that runs post-install sync in a fresh subprocess.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { getPackageVersion, PACKAGE_NAME } from "../lib/package.js";

const NPM_REGISTRY = "https://registry.npmjs.org";
type UpgradeCommand = readonly [string, ...string[]];

export type UpgradeFlowResult = {
  exitCode: number;
  status: "already-latest" | "registry-failed" | "install-failed" | "sync-warning" | "upgraded";
};

export type UpgradeSubprocessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type UpgradeLogger = Pick<Console, "error" | "log" | "warn">;

type UpgradeDependencies = {
  fetchChangelog: (fromVersion: string, toVersion: string) => Promise<string | null>;
  fetchLatestVersion: () => Promise<string | null>;
  getCurrentVersion: () => Promise<string>;
  logger: UpgradeLogger;
  runSubprocess: (command: UpgradeCommand) => Promise<UpgradeSubprocessResult>;
};

export default defineCommand({
  meta: {
    name: "upgrade",
    description: "Upgrade the global vvoc package and sync config.",
  },
  async run() {
    // START_BLOCK_RUN_UPGRADE
    const result = await runUpgradeFlow();
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode;
    }
    // END_BLOCK_RUN_UPGRADE
  },
});

export async function runUpgradeFlow(
  overrides: Partial<UpgradeDependencies> = {},
): Promise<UpgradeFlowResult> {
  const logger = overrides.logger ?? console;
  const fetchLatest = overrides.fetchLatestVersion ?? fetchLatestVersion;
  const fetchReleaseNotes = overrides.fetchChangelog ?? fetchChangelog;
  const getCurrentVersion = overrides.getCurrentVersion ?? getPackageVersion;
  const runSubprocess = overrides.runSubprocess ?? runSubprocessCommand;

  try {
    const [currentVersion, latestVersion] = await Promise.all([getCurrentVersion(), fetchLatest()]);

    if (!latestVersion) {
      logger.error("NETWORK_ERROR: Could not reach npm registry");
      return { exitCode: 1, status: "registry-failed" };
    }

    if (compareVersions(currentVersion, latestVersion) >= 0) {
      logger.log(`Already at latest version: ${currentVersion}`);
      return { exitCode: 0, status: "already-latest" };
    }

    logger.log(`Current version: ${currentVersion}`);
    logger.log(`Latest version: ${latestVersion}`);
    logger.log("Upgrade available!");

    const changelog = await getBestEffortChangelog({
      currentVersion,
      latestVersion,
      fetchChangelog: fetchReleaseNotes,
    });
    if (changelog) {
      logger.log("\n--- Changelog ---");
      logger.log(changelog);
    }

    const installCommand = buildInstallCommand(latestVersion);
    logger.log("\nInstalling global package:");
    logger.log(`  ${formatCommand(installCommand)}`);

    let installResult: UpgradeSubprocessResult;
    try {
      installResult = await runSubprocess(installCommand);
    } catch (error) {
      logger.error(`Upgrade install failed: ${formatError(error)}`);
      return { exitCode: 1, status: "install-failed" };
    }

    if (installResult.exitCode !== 0) {
      logProcessOutput(logger.error, installResult.stdout);
      logProcessOutput(logger.error, installResult.stderr);
      logger.error("Upgrade install failed.");
      return {
        exitCode: installResult.exitCode || 1,
        status: "install-failed",
      };
    }

    logProcessOutput(logger.log, installResult.stdout);
    logProcessOutput(logger.warn, installResult.stderr);
    logger.log("Global upgrade installed successfully.");

    const syncCommand = buildPostInstallSyncCommand();
    logger.log("\nRunning post-upgrade sync:");
    logger.log(`  ${formatCommand(syncCommand)}`);

    let syncResult: UpgradeSubprocessResult;
    try {
      syncResult = await runSubprocess(syncCommand);
    } catch (error) {
      warnManualSync(logger, `Could not launch sync: ${formatError(error)}`);
      return { exitCode: 0, status: "sync-warning" };
    }

    if (syncResult.exitCode !== 0) {
      logProcessOutput(logger.warn, syncResult.stdout);
      logProcessOutput(logger.warn, syncResult.stderr);
      warnManualSync(logger, "Post-upgrade sync failed.");
      return { exitCode: 0, status: "sync-warning" };
    }

    logProcessOutput(logger.log, syncResult.stdout);
    logProcessOutput(logger.warn, syncResult.stderr);
    logger.log("Upgrade complete.");
    return { exitCode: 0, status: "upgraded" };
  } catch (error) {
    logger.error(`Upgrade check failed: ${formatError(error)}`);
    return { exitCode: 1, status: "registry-failed" };
  }
}

export function buildInstallCommand(latestVersion: string): UpgradeCommand {
  return ["bun", "add", "-g", `${PACKAGE_NAME}@${latestVersion}`];
}

export function buildPostInstallSyncCommand(): UpgradeCommand {
  return ["vvoc", "sync"];
}

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

// START_BLOCK_RUN_UPGRADE_SUBPROCESS
async function runSubprocessCommand(command: UpgradeCommand): Promise<UpgradeSubprocessResult> {
  const proc = Bun.spawn({
    cmd: [...command],
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readProcessStream(proc.stdout),
    readProcessStream(proc.stderr),
    proc.exited,
  ]);

  return { exitCode, stderr, stdout };
}
// END_BLOCK_RUN_UPGRADE_SUBPROCESS

async function getBestEffortChangelog({
  currentVersion,
  fetchChangelog,
  latestVersion,
}: {
  currentVersion: string;
  fetchChangelog: (fromVersion: string, toVersion: string) => Promise<string | null>;
  latestVersion: string;
}): Promise<string | null> {
  try {
    const changelog = await fetchChangelog(currentVersion, latestVersion);
    return changelog?.trim() ? changelog : null;
  } catch {
    return null;
  }
}

async function readProcessStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return "";
  }

  return new Response(stream).text();
}

function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);

  if (!leftVersion || !rightVersion) {
    return left.localeCompare(right, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  for (let index = 0; index < 3; index += 1) {
    const difference = leftVersion.release[index] - rightVersion.release[index];
    if (difference !== 0) {
      return difference;
    }
  }

  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length === 0) {
    return 0;
  }

  if (leftVersion.prerelease.length === 0) {
    return 1;
  }

  if (rightVersion.prerelease.length === 0) {
    return -1;
  }

  const prereleaseLength = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];

    if (leftIdentifier === undefined) {
      return -1;
    }

    if (rightIdentifier === undefined) {
      return 1;
    }

    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);

    if (leftNumeric && rightNumeric) {
      const difference = Number(leftIdentifier) - Number(rightIdentifier);
      if (difference !== 0) {
        return difference;
      }
      continue;
    }

    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }

    const difference = leftIdentifier.localeCompare(rightIdentifier);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function parseVersion(value: string): {
  prerelease: string[];
  release: [number, number, number];
} | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  );

  if (!match) {
    return null;
  }

  return {
    prerelease: match[4] ? match[4].split(".") : [],
    release: [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)],
  };
}

function formatCommand(command: UpgradeCommand): string {
  return command.join(" ");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logProcessOutput(write: (message: string) => void, output: string): void {
  const trimmed = output.trim();
  if (trimmed) {
    write(trimmed);
  }
}

function warnManualSync(logger: UpgradeLogger, reason: string): void {
  logger.warn(reason);
  logger.warn("Upgrade installed successfully, but post-install sync did not complete.");
  logger.warn("Run `vvoc sync` manually to finish refreshing the global config.");
}
