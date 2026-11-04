// FILE: src/lib/host-compat.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Single source of truth for the supported and verified native OpenCode host window.
//   SCOPE: Semantic-version parsing, the hard supported window (major-bounded, prereleases refused), the verified-host list read from hosts.json, and the verified/tolerated/unsupported classification used by runtime discovery, CLI inspection, and the host gates.
//   DEPENDS: [src/hosts.json]
//   LINKS: [M-HOST-COMPAT, V-M-HOST-COMPAT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MIN_SUPPORTED_OPENCODE_VERSION - Oldest native OpenCode host vvoc accepts.
//   MAX_SUPPORTED_OPENCODE_VERSION_EXCLUSIVE - First native OpenCode major version vvoc refuses.
//   SUPPORTED_OPENCODE_VERSION_RANGE - Human-readable hard supported window.
//   VERIFIED_HOST_VERSIONS - Host versions with fresh live-host evidence, newest first.
//   VERIFIED_HOST_VERSION - Newest verified host version, or the window floor when the list is empty.
//   OpenCodeHostSupport - Support classification for one host version.
//   parseOpenCodeVersion - Parse a stable semantic version into numeric components.
//   isSupportedOpenCodeVersion - True only inside the hard supported window (no prereleases).
//   isVerifiedOpenCodeVersion - True when the exact version carries live-host evidence.
//   openCodeHostSupport - Classify one host version as verified, tolerated, or unsupported.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-HOST-COMPAT-WINDOW T-001 - Replaced the exact 2.0.18 patch pin with a major-bounded supported window plus a data-driven verified-host list, so upstream patches are tolerated without a vvoc release while unverified minors stay visibly separated from evidenced ones.]
// END_CHANGE_SUMMARY

import hosts from "../hosts.json" with { type: "json" };

/** Oldest native OpenCode host vvoc accepts. */
export const MIN_SUPPORTED_OPENCODE_VERSION = "2.0.18";

/** First native OpenCode major version vvoc refuses: majors are never tolerated implicitly. */
export const MAX_SUPPORTED_OPENCODE_VERSION_EXCLUSIVE = "3.0.0";

/** Human-readable hard supported window. */
export const SUPPORTED_OPENCODE_VERSION_RANGE = `>=${MIN_SUPPORTED_OPENCODE_VERSION} <${MAX_SUPPORTED_OPENCODE_VERSION_EXCLUSIVE}`;

/** Host versions with fresh live-host evidence, newest first. */
export const VERIFIED_HOST_VERSIONS: readonly string[] = Object.freeze(
  [...(hosts.verified ?? [])].sort(compareVersionStrings),
);

/** Newest verified host version, or the window floor when no evidence is recorded. */
export const VERIFIED_HOST_VERSION = VERIFIED_HOST_VERSIONS[0] ?? MIN_SUPPORTED_OPENCODE_VERSION;

/** Support classification for one host version. */
export type OpenCodeHostSupport = "verified" | "tolerated" | "unsupported";

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

// START_CONTRACT: parseOpenCodeVersion
//   PURPOSE: Parse a stable semantic version into numeric components, rejecting prereleases and non-versions.
//   INPUTS: { version: string - output of `opencode --version`, optionally v-prefixed. }
//   OUTPUTS: { readonly [number, number, number] | undefined - major/minor/patch, or undefined when unstable or unparsable. }
//   SIDE_EFFECTS: none
//   LINKS: [const-MIN_SUPPORTED_OPENCODE_VERSION]
// END_CONTRACT: parseOpenCodeVersion
export function parseOpenCodeVersion(
  version: string,
): readonly [number, number, number] | undefined {
  const match = version.trim().match(VERSION_PATTERN);
  if (!match) return undefined;
  // Prerelease builds are outside the supported stable window.
  if (match[4] !== undefined) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

function compareVersions(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/** Order two version strings newest first; unparsable versions sort last. */
function compareVersionStrings(left: string, right: string): number {
  const a = parseOpenCodeVersion(left);
  const b = parseOpenCodeVersion(right);
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  return compareVersions(b, a);
}

// START_CONTRACT: isSupportedOpenCodeVersion
//   PURPOSE: Accept any stable host inside the hard window and refuse older, non-2.x, and prerelease builds.
//   INPUTS: { version: string - `opencode --version` semantic version, optionally v-prefixed. }
//   OUTPUTS: { boolean - True inside >=MIN <MAX with no prerelease suffix. }
//   SIDE_EFFECTS: none
//   LINKS: [const-SUPPORTED_OPENCODE_VERSION_RANGE]
// END_CONTRACT: isSupportedOpenCodeVersion
export function isSupportedOpenCodeVersion(version: string): boolean {
  const current = parseOpenCodeVersion(version);
  if (current === undefined) return false;
  return (
    compareVersions(current, parseOpenCodeVersion(MIN_SUPPORTED_OPENCODE_VERSION)!) >= 0 &&
    compareVersions(current, parseOpenCodeVersion(MAX_SUPPORTED_OPENCODE_VERSION_EXCLUSIVE)!) < 0
  );
}

// START_CONTRACT: isVerifiedOpenCodeVersion
//   PURPOSE: Report whether this exact stable version carries live-host evidence.
//   INPUTS: { version: string - `opencode --version` semantic version. }
//   OUTPUTS: { boolean - True when the normalized version is listed in hosts.json. }
//   SIDE_EFFECTS: none
//   LINKS: [const-VERIFIED_HOST_VERSIONS]
// END_CONTRACT: isVerifiedOpenCodeVersion
export function isVerifiedOpenCodeVersion(version: string): boolean {
  const normalized = version.trim().replace(/^v/, "");
  return VERIFIED_HOST_VERSIONS.includes(normalized);
}

// START_CONTRACT: openCodeHostSupport
//   PURPOSE: Classify one host version for CLI reporting, runtime discovery, and gate authorization.
//   INPUTS: { version: string - `opencode --version` semantic version. }
//   OUTPUTS: { OpenCodeHostSupport - verified inside the window with evidence, tolerated inside the window without it, unsupported outside. }
//   SIDE_EFFECTS: none
//   LINKS: [fn-isSupportedOpenCodeVersion, fn-isVerifiedOpenCodeVersion]
// END_CONTRACT: openCodeHostSupport
export function openCodeHostSupport(version: string): OpenCodeHostSupport {
  if (!isSupportedOpenCodeVersion(version)) return "unsupported";
  return isVerifiedOpenCodeVersion(version) ? "verified" : "tolerated";
}
