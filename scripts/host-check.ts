#!/usr/bin/env bun
// FILE: scripts/host-check.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Report upstream OpenCode drift against the shipped compatibility window and verified-host list, and prepare a downloaded host binary for the live contract gates.
//   SCOPE: Registry lookup of @opencode/cli stable versions, window/verified classification of the newest stable release, a human-readable drift report with an actionable next step, and an opt-in host download into the shared scratch root with the exact env command for contracts:host. No repository mutation and no gate execution.
//   DEPENDS: [node:fs, node:path, node:child_process, src/lib/host-compat.ts, src/hosts.json]
//   LINKS: [M-HOST-COMPAT, V-M-HOST-COMPAT]
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   REGISTRY_URL - Public npm registry endpoint for @opencode/cli.
//   HOST_SCRATCH_PARENT - Shared scratch parent for downloaded host binaries.
//   VersionClassification - Window/verified classification of one upstream version.
//   RegistryDocument - Minimal npm registry document shape used by the helpers.
//   nextStepFor - Actionable next step for the newest classified release.
//   fetchRegistry - Read the public registry document for @opencode/cli.
//   stableVersions - Filter a registry version map down to stable semver releases.
//   newestStable - Highest stable version from a registry version map.
//   classifyHosts - Classify upstream versions against the shipped window and evidence.
//   formatDriftReport - Render the bounded drift report and next step.
//   downloadHost - Install one @opencode/cli version into the scratch root and return its binary path.
//   main - CLI entry point.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-HOST-COMPAT-WINDOW T-006 - Added the upstream drift reporter that classifies the newest stable OpenCode release against the window and verified list and can fetch that exact host for the live gates.]
// END_CHANGE_SUMMARY

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_SUPPORTED_OPENCODE_VERSION_EXCLUSIVE,
  MIN_SUPPORTED_OPENCODE_VERSION,
  openCodeHostSupport,
  parseOpenCodeVersion,
  SUPPORTED_OPENCODE_VERSION_RANGE,
  VERIFIED_HOST_VERSIONS,
} from "../src/lib/host-compat.ts";

/** Public npm registry endpoint for @opencode/cli. */
export const REGISTRY_URL = "https://registry.npmjs.org/@opencode/cli";

/** Shared scratch parent for downloaded host binaries. */
export const HOST_SCRATCH_PARENT = process.env.VVOC_E2E_SCRATCH ?? "/tmp/opencode";

/** Window/verified classification of one upstream version. */
export type VersionClassification = {
  readonly version: string;
  readonly support: "verified" | "tolerated" | "unsupported";
};

type RegistryDocument = {
  readonly versions?: Record<string, unknown>;
  readonly "dist-tags"?: Record<string, string>;
};

/** Filter a registry version map down to stable semver releases, newest first. */
export function stableVersions(document: RegistryDocument): string[] {
  return Object.keys(document.versions ?? {})
    .filter((version) => parseOpenCodeVersion(version) !== undefined)
    .sort((left, right) => {
      const a = parseOpenCodeVersion(left)!;
      const b = parseOpenCodeVersion(right)!;
      return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
    });
}

/** Highest stable version from a registry version map. */
export function newestStable(document: RegistryDocument): string | undefined {
  const versions = stableVersions(document);
  const latestTag = document["dist-tags"]?.latest;
  if (latestTag !== undefined && parseOpenCodeVersion(latestTag) !== undefined) {
    return latestTag;
  }
  return versions[0];
}

/** Classify upstream versions against the shipped window and evidence. */
export function classifyHosts(versions: readonly string[]): VersionClassification[] {
  return versions.map((version) => ({
    version,
    support: openCodeHostSupport(version),
  }));
}

/** Render the bounded drift report and next step. */
export function formatDriftReport(
  classification: readonly VersionClassification[],
  pinnedVersion: string,
): string {
  const newest = classification[0];
  const lines = [
    "vvoc host drift report",
    `window=${SUPPORTED_OPENCODE_VERSION_RANGE} (floor ${MIN_SUPPORTED_OPENCODE_VERSION}, major bound ${MAX_SUPPORTED_OPENCODE_VERSION_EXCLUSIVE})`,
    `verified=${VERIFIED_HOST_VERSIONS.join(", ") || "none"}`,
    `pinnedBuildVersion=${pinnedVersion}`,
    `newestStable=${newest?.version ?? "unknown"} (${newest?.support ?? "unknown"})`,
    `nextStep=${nextStepFor(newest, pinnedVersion)}`,
  ];
  const recent = classification.slice(0, 5);
  if (recent.length > 0) {
    lines.push("recent:");
    for (const item of recent) lines.push(`  ${item.version} ${item.support}`);
  }
  return lines.join("\n");
}

function nextStepFor(
  newest: VersionClassification | undefined,
  pinnedVersion: string,
): string {
  if (newest === undefined) return "could not read upstream versions; rerun when the registry is reachable";
  if (newest.support === "unsupported") {
    return `outside the window: run the migration change before accepting ${newest.version}`;
  }
  if (newest.support === "verified") {
    return "nothing to do: the newest stable host is verified";
  }
  if (newest.version === pinnedVersion) {
    return `run the live gates against ${pinnedVersion} to move it into the verified list`;
  }
  return `bump train: update build pins to ${newest.version}, run host gates, then publish a patch with the new verified entry`;
}

/** Install one @opencode/cli version into the scratch root and return its binary path. */
export async function downloadHost(version: string): Promise<string> {
  const directory = join(HOST_SCRATCH_PARENT, `host-${version}`);
  const binary = join(directory, "node_modules", "@opencode", "cli", "bin", "opencode.exe");
  if (existsSync(binary)) return binary;
  const install = Bun.spawn({
    cmd: ["bun", "add", `@opencode/cli@${version}`],
    cwd: directory,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(HOST_SCRATCH_PARENT, ".bun-cache") },
  });
  const code = await install.exited;
  if (code !== 0) throw new Error(`failed to install @opencode/cli@${version} (exit ${code})`);
  if (!existsSync(binary)) throw new Error(`installed @opencode/cli@${version} but found no binary`);
  return binary;
}

async function fetchRegistry(): Promise<RegistryDocument> {
  const response = await fetch(REGISTRY_URL, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`registry responded ${response.status}`);
  return (await response.json()) as RegistryDocument;
}

/** CLI entry point. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const downloadArg = argv.indexOf("--download");
  const requested = downloadArg >= 0 ? argv[downloadArg + 1] : undefined;
  const packageJson = (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as {
    dependencies?: Record<string, string>;
  };
  const pinnedVersion = packageJson.dependencies?.["@opencode/plugin"] ?? "unknown";

  if (requested !== undefined) {
    const binary = await downloadHost(requested);
    const sha = createHash("sha256").update(await Bun.file(binary).arrayBuffer()).digest("hex");
    console.log(`downloaded @opencode/cli@${requested}`);
    console.log(`binary=${binary}`);
    console.log(`sha256=${sha}`);
    console.log(
      `run: VVOC_HOST_VERSION=${requested} VVOC_E2E_V2_HOST=${binary} VVOC_E2E_V2_HOST_SHA256=${sha} bun run contracts:host`,
    );
    return 0;
  }

  const classification = classifyHosts(stableVersions(await fetchRegistry()).slice(0, 8));
  console.log(formatDriftReport(classification, pinnedVersion));
  const newest = classification[0];
  return newest === undefined ? 1 : newest.support === "verified" ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main());
}
