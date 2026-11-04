// FILE: src/lib/opencode/plugin-registration.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Conservative native OpenCode plugin registration for the pinned combined base package, re-exporting the host compatibility window owned by src/lib/host-compat.ts.
//   SCOPE: Native `plugins` array parsing/normalization preserving `-target` removal directives, string entries, `{package, options}` objects and their options while upgrading the pinned vvoc package and migrating legacy `/tui` specs; idempotent writes into opencode.json(c); re-exported supported-window constants and predicate.
//   DEPENDS: [jsonc-parser, src/lib/package.ts, src/lib/host-compat.ts, src/lib/opencode/shared-utils.ts]
//   LINKS: [M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MIN_SUPPORTED_OPENCODE_VERSION - Lowest supported native OpenCode host version (re-exported).
//   MAX_SUPPORTED_OPENCODE_VERSION_EXCLUSIVE - First unsupported native OpenCode host version (re-exported).
//   SUPPORTED_OPENCODE_VERSION_RANGE - Human-readable supported native OpenCode host window (re-exported).
//   TUI_PACKAGE_SPECIFIER - Pinned combined base package specifier used for TUI registration.
//   isSupportedOpenCodeVersion - True only inside the supported native OpenCode host window (re-exported).
//   ensurePackageConfigText - Ensures OpenCode config registers the pinned combined base package in the native `plugins` array.
//   ensurePackageInstalled - Writes the pinned vvoc package into OpenCode config.
//   isManagedPackageTarget - True when a plugin target is the vvoc base package or a legacy `/tui` subpath.
//   normalizePluginEntries - Rewrites the managed vvoc entry to the requested specifier preserving options and order.
//   JsonObject - Re-exported JSON object shape for native config documents.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-HOST-COMPAT-WINDOW T-001 - Moved the supported host window to src/lib/host-compat.ts as a major-bounded predicate with a data-driven verified list; this module keeps re-exporting the same names so config registration call sites are unchanged.]
//   PREVIOUS: [C-OPENCODE-V2-NATIVE T-007 - Replaced the V1 `plugin` string tuple handling with the native `plugins` array of string and {package, options} entries; removed the dedicated tui.json writer.]
// END_CHANGE_SUMMARY

import { applyEdits, format, modify } from "jsonc-parser";
import { dirname } from "node:path";
import { getPinnedPackageSpecifier, PACKAGE_NAME, PACKAGE_VERSION } from "../package.js";
import {
  assertNativeOpenCodeDocument,
  ensureTrailingNewline,
  OPENCODE_SCHEMA_URL,
  parseObjectDocument,
  readOptionalText,
  readPluginEntries,
  renderJson,
  type NativeValidationContext,
  writeText,
  type JsonObject,
  type OpenCodePluginEntry,
} from "./shared-utils.js";
import type { ResolvedPaths } from "./paths.js";

export {
  MIN_SUPPORTED_OPENCODE_VERSION,
  MAX_SUPPORTED_OPENCODE_VERSION_EXCLUSIVE,
  SUPPORTED_OPENCODE_VERSION_RANGE,
  isSupportedOpenCodeVersion,
} from "../host-compat.js";

/** The combined base package is registered once in native `plugins` for both server and TUI consumption. */
export const TUI_PACKAGE_SPECIFIER = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;

const JSON_FORMAT = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const;

// START_BLOCK_ENSURE_OPENCODE_PLUGIN_CONFIG
export function ensurePackageConfigText(
  text: string | undefined,
  packageSpecifier = PACKAGE_NAME,
  context: NativeValidationContext = {},
): string {
  if (!text?.trim()) {
    return renderJson({
      $schema: OPENCODE_SCHEMA_URL,
      plugins: [{ package: packageSpecifier }],
    });
  }

  const document = parseObjectDocument(text, "OpenCode config");
  assertNativeOpenCodeDocument(document, "OpenCode config", context);
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
  const nextText = ensurePackageConfigText(currentText, await getPinnedPackageSpecifier(), {
    configDir: dirname(paths.opencodeConfigPath),
  });

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
