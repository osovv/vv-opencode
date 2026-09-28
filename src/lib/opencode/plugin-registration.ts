// FILE: src/lib/opencode/plugin-registration.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Conservative native OpenCode plugin registration and host compatibility window for the pinned combined base package.
//   SCOPE: Native `plugins` array parsing/normalization preserving `-target` removal directives, string entries, `{package, options}` objects and their options while upgrading the pinned vvoc package and migrating legacy `/tui` specs; exact supported native host window predicate; idempotent writes into opencode.json(c).
//   DEPENDS: [jsonc-parser, src/lib/package.ts, src/lib/opencode/shared-utils.ts]
//   LINKS: [M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MIN_SUPPORTED_OPENCODE_VERSION - Lowest supported native OpenCode host version.
//   MAX_SUPPORTED_OPENCODE_VERSION_EXCLUSIVE - First unsupported native OpenCode host version (exclusive upper bound).
//   SUPPORTED_OPENCODE_VERSION_RANGE - Human-readable exact supported native OpenCode host window.
//   isSupportedOpenCodeVersion - True only for the exact supported native OpenCode host window (no prereleases).
//   ensurePackageConfigText - Ensures OpenCode config registers the pinned combined base package in the native `plugins` array.
//   ensurePackageInstalled - Writes the pinned vvoc package into OpenCode config.
//   isManagedPackageTarget - True when a plugin target is the vvoc base package or a legacy `/tui` subpath.
//   normalizePluginEntries - Rewrites the managed vvoc entry to the requested specifier preserving options and order.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-007 - Replaced the V1 `plugin` string tuple handling with the native `plugins` array of string and {package, options} entries; removed the dedicated tui.json writer.]
// END_CHANGE_SUMMARY

import { applyEdits, format, modify } from "jsonc-parser";
import { getPinnedPackageSpecifier, PACKAGE_NAME, PACKAGE_VERSION } from "../package.js";
import {
  assertNativeOpenCodeDocument,
  ensureTrailingNewline,
  OPENCODE_SCHEMA_URL,
  parseObjectDocument,
  readOptionalText,
  readPluginEntries,
  renderJson,
  writeText,
  type JsonObject,
  type OpenCodePluginEntry,
} from "./shared-utils.js";
import type { ResolvedPaths } from "./paths.js";

export const MIN_SUPPORTED_OPENCODE_VERSION = "2.0.18";
export const MAX_SUPPORTED_OPENCODE_VERSION_EXCLUSIVE = "2.0.19";
export const SUPPORTED_OPENCODE_VERSION_RANGE = `>=${MIN_SUPPORTED_OPENCODE_VERSION} <${MAX_SUPPORTED_OPENCODE_VERSION_EXCLUSIVE}`;

/** The combined base package is registered once in native `plugins` for both server and TUI consumption. */
export const TUI_PACKAGE_SPECIFIER = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;

// START_CONTRACT: isSupportedOpenCodeVersion
//   PURPOSE: Accept only the exact pinned native OpenCode host window, rejecting older, newer, and prerelease builds.
//   INPUTS: { version: string - `opencode --version` semantic version, optionally v-prefixed. }
//   OUTPUTS: { boolean - True only for 2.0.18 with no prerelease suffix. }
//   SIDE_EFFECTS: none
//   LINKS: [const-MIN_SUPPORTED_OPENCODE_VERSION]
// END_CONTRACT: isSupportedOpenCodeVersion
export function isSupportedOpenCodeVersion(version: string): boolean {
  const match = version
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return false;
  // Prerelease builds are outside the supported stable window.
  if (match[4] !== undefined) return false;

  const current = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const minimum = [2, 0, 18] as const;
  const maximum = [2, 0, 19] as const;
  const compare = (left: readonly number[], right: readonly number[]): number =>
    (left[0] ?? 0) - (right[0] ?? 0) ||
    (left[1] ?? 0) - (right[1] ?? 0) ||
    (left[2] ?? 0) - (right[2] ?? 0);
  return compare(current, minimum) >= 0 && compare(current, maximum) < 0;
}

const JSON_FORMAT = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const;

// START_BLOCK_ENSURE_OPENCODE_PLUGIN_CONFIG
export function ensurePackageConfigText(
  text: string | undefined,
  packageSpecifier = PACKAGE_NAME,
): string {
  if (!text?.trim()) {
    return renderJson({
      $schema: OPENCODE_SCHEMA_URL,
      plugins: [{ package: packageSpecifier }],
    });
  }

  const document = parseObjectDocument(text, "OpenCode config");
  assertNativeOpenCodeDocument(document, "OpenCode config");
  const currentPlugins = readPluginEntries(document, "OpenCode config");
  let nextText = text;

  if (!Object.hasOwn(document, "$schema")) {
    nextText = applyEdits(
      nextText,
      modify(nextText, ["$schema"], OPENCODE_SCHEMA_URL, {
        formattingOptions: JSON_FORMAT,
        getInsertionIndex: () => 0,
      }),
    );
  }

  const nextPlugins = normalizePluginEntries(currentPlugins, packageSpecifier);
  if (JSON.stringify(nextPlugins) !== JSON.stringify(currentPlugins)) {
    nextText = applyEdits(
      nextText,
      modify(nextText, ["plugins"], nextPlugins, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
}
// END_BLOCK_ENSURE_OPENCODE_PLUGIN_CONFIG

// START_BLOCK_INSTALL_PACKAGE_AND_GUARDIAN_CONFIG
export async function ensurePackageInstalled(paths: ResolvedPaths): Promise<{
  path: string;
  changed: boolean;
}> {
  const currentText = await readOptionalText(paths.opencodeConfigPath);
  const nextText = ensurePackageConfigText(currentText, await getPinnedPackageSpecifier());

  if (currentText === nextText) {
    return { path: paths.opencodeConfigPath, changed: false };
  }

  await writeText(paths.opencodeConfigPath, nextText);
  return { path: paths.opencodeConfigPath, changed: true };
}
// END_BLOCK_INSTALL_PACKAGE_AND_GUARDIAN_CONFIG

// START_BLOCK_PARSE_AND_NORMALIZE_CONFIG_VALUES
export function isManagedPackageTarget(value: string): boolean {
  return (
    isBasePackageSpecifier(value) ||
    value === `${PACKAGE_NAME}/tui` ||
    (value.startsWith(`${PACKAGE_NAME}@`) && value.endsWith("/tui"))
  );
}

export function normalizePluginEntries(
  currentPlugins: OpenCodePluginEntry[],
  packageSpecifier: string,
): OpenCodePluginEntry[] {
  const nextPlugins: OpenCodePluginEntry[] = [];
  let managedIndex = -1;

  for (const entry of currentPlugins) {
    const target = typeof entry === "string" ? entry : entry.package;
    if (!isManagedPackageTarget(target)) {
      nextPlugins.push(entry);
      continue;
    }

    const options = typeof entry === "string" ? undefined : entry.options;
    if (managedIndex !== -1) {
      // Multiple managed entries with divergent options are ambiguous; refuse
      // instead of silently keeping the first and dropping the user's later one.
      const existing = nextPlugins[managedIndex];
      const existingOptions = typeof existing === "string" ? undefined : existing.options;
      if (JSON.stringify(existingOptions) !== JSON.stringify(options)) {
        throw new Error(
          `OpenCode config: conflicting managed plugin entries for ${PACKAGE_NAME}; keep exactly one`,
        );
      }
      continue;
    }
    managedIndex = nextPlugins.length;
    nextPlugins.push(
      options === undefined
        ? { package: packageSpecifier }
        : { package: packageSpecifier, options },
    );
  }

  if (managedIndex === -1) {
    nextPlugins.push({ package: packageSpecifier });
  }

  return nextPlugins;
}

function isBasePackageSpecifier(value: string): boolean {
  if (value === PACKAGE_NAME) return true;
  const prefix = `${PACKAGE_NAME}@`;
  return value.startsWith(prefix) && !value.slice(prefix.length).includes("/");
}
// END_BLOCK_PARSE_AND_NORMALIZE_CONFIG_VALUES

export type { JsonObject };
