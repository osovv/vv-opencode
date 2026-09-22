// FILE: src/lib/opencode/plugin-registration.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Conservative pinned runtime and TUI plugin registration for OpenCode config.
//   SCOPE: Pinned base-package specifier constants, plugin-list parsing and normalization with legacy /tui spec migration and tuple-option preservation, and idempotent writes of the pinned vvoc plugin into opencode.json(c) and the pinned base package into tui.json(c).
//   DEPENDS: [jsonc-parser, src/lib/package.ts, src/lib/opencode/shared-utils.ts]
//   LINKS: [M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   TUI_PACKAGE_SPECIFIER - Pinned base package specifier registered in tui.json(c) so OpenCode selects its ./tui export.
//   MINIMUM_TUI_OPENCODE_VERSION - Minimum OpenCode host version supported by the managed TUI plugin.
//   TuiPluginEntry - Supported TUI plugin string or tuple entry.
//   ensurePackageConfigText - Ensures OpenCode config contains the pinned vvoc plugin specifier.
//   ensureTuiPackageConfigText - Ensures TUI config contains the pinned vvoc base package while preserving tuple options.
//   ensureTuiPackageInstalled - Writes the pinned vvoc base package into dedicated tui.json(c).
//   ensurePackageInstalled - Writes the pinned vvoc plugin specifier into OpenCode config.
//   readPluginList - Reads the runtime plugin array from a parsed OpenCode config.
//   readTuiPluginList - Reads the TUI plugin array accepting string and tuple entries.
//   isPackagePluginSpecifier - True when a plugin entry is the vvoc base package.
//   isTuiPackageSpecifier - True when a TUI entry equals the pinned base package specifier.
//   readTuiPluginName - Extracts the name from a TUI plugin entry.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-MODULE-SPLIT - Extracted runtime/TUI plugin pinning and plugin-list normalization from the former src/lib/opencode.ts monolith into this zone module.]
// END_CHANGE_SUMMARY

import { applyEdits, format, modify } from "jsonc-parser";
import { getPinnedPackageSpecifier, PACKAGE_NAME, PACKAGE_VERSION } from "../package.js";
import {
  ensureTrailingNewline,
  isJsonObject,
  OPENCODE_SCHEMA_URL,
  OPENCODE_TUI_SCHEMA_URL,
  parseObjectDocument,
  readOptionalText,
  renderJson,
  writeText,
  type JsonObject,
  type WriteResult,
} from "./shared-utils.js";
import type { ResolvedPaths } from "./paths.js";

export const TUI_PACKAGE_SPECIFIER = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;
export const MINIMUM_TUI_OPENCODE_VERSION = "1.18.2";

const JSON_FORMAT = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const;

export type TuiPluginEntry = string | [string, JsonObject];

// START_BLOCK_ENSURE_OPENCODE_PLUGIN_CONFIG
export function ensurePackageConfigText(
  text: string | undefined,
  packageSpecifier = PACKAGE_NAME,
): string {
  if (!text?.trim()) {
    return renderJson({
      $schema: OPENCODE_SCHEMA_URL,
      plugin: [packageSpecifier],
    });
  }

  const document = parseObjectDocument(text, "OpenCode config");
  const currentPlugins = readPluginList(document, "OpenCode config");
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

  const nextPlugins = normalizePluginList(currentPlugins, packageSpecifier);
  if (JSON.stringify(nextPlugins) !== JSON.stringify(currentPlugins)) {
    nextText = applyEdits(
      nextText,
      modify(nextText, ["plugin"], nextPlugins, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
}
// END_BLOCK_ENSURE_OPENCODE_PLUGIN_CONFIG

// START_BLOCK_ENSURE_TUI_PLUGIN_CONFIG
export function ensureTuiPackageConfigText(
  text: string | undefined,
  packageSpecifier = TUI_PACKAGE_SPECIFIER,
): string {
  if (!text?.trim()) {
    return renderJson({
      $schema: OPENCODE_TUI_SCHEMA_URL,
      plugin: [packageSpecifier],
    });
  }

  const document = parseObjectDocument(text, "OpenCode TUI config");
  const currentPlugins = readTuiPluginList(document, "OpenCode TUI config");
  let nextText = text;

  if (!Object.hasOwn(document, "$schema")) {
    nextText = applyEdits(
      nextText,
      modify(nextText, ["$schema"], OPENCODE_TUI_SCHEMA_URL, {
        formattingOptions: JSON_FORMAT,
        getInsertionIndex: () => 0,
      }),
    );
  }

  const nextPlugins = normalizeTuiPluginList(currentPlugins, packageSpecifier);
  if (JSON.stringify(nextPlugins) !== JSON.stringify(currentPlugins)) {
    nextText = applyEdits(
      nextText,
      modify(nextText, ["plugin"], nextPlugins, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
}

export async function ensureTuiPackageInstalled(
  paths: Pick<ResolvedPaths, "opencodeTuiConfigPath">,
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.opencodeTuiConfigPath);
  const nextText = ensureTuiPackageConfigText(currentText);
  if ((currentText ?? "") === nextText) {
    return { action: "kept", path: paths.opencodeTuiConfigPath };
  }

  await writeText(paths.opencodeTuiConfigPath, nextText);
  return {
    action: currentText ? "updated" : "created",
    path: paths.opencodeTuiConfigPath,
  };
}
// END_BLOCK_ENSURE_TUI_PLUGIN_CONFIG

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
export function readPluginList(document: JsonObject, label: string): string[] {
  const raw = document.plugin;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label}: expected "plugin" to be an array of strings`);
  }
  return raw.slice();
}

export function readTuiPluginList(document: JsonObject, label: string): TuiPluginEntry[] {
  const raw = document.plugin;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${label}: expected "plugin" to be an array`);
  }

  return raw.map((entry, index) => {
    if (typeof entry === "string") {
      return entry;
    }
    if (
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === "string" &&
      isJsonObject(entry[1])
    ) {
      return [entry[0], entry[1]];
    }
    throw new Error(
      `${label}: expected "plugin[${index}]" to be a string or [string, options] tuple`,
    );
  });
}

function normalizePluginList(currentPlugins: string[], packageSpecifier: string): string[] {
  const nextPlugins: string[] = [];
  const seen = new Set<string>();
  let insertedPackage = false;

  const push = (value: string) => {
    if (!seen.has(value)) {
      seen.add(value);
      nextPlugins.push(value);
    }
  };

  for (const plugin of currentPlugins) {
    if (isPackagePluginSpecifier(plugin)) {
      if (!insertedPackage) {
        push(packageSpecifier);
        insertedPackage = true;
      }
      continue;
    }

    push(plugin);
  }

  if (!insertedPackage) {
    push(packageSpecifier);
  }

  return nextPlugins;
}

function normalizeTuiPluginList(
  currentPlugins: TuiPluginEntry[],
  packageSpecifier: string,
): TuiPluginEntry[] {
  const nextPlugins: TuiPluginEntry[] = [];
  let insertedPackage = false;

  for (const entry of currentPlugins) {
    if (!isManagedTuiPackageSpecifier(readTuiPluginName(entry))) {
      nextPlugins.push(entry);
      continue;
    }

    if (insertedPackage) {
      continue;
    }
    nextPlugins.push(typeof entry === "string" ? packageSpecifier : [packageSpecifier, entry[1]]);
    insertedPackage = true;
  }

  if (!insertedPackage) {
    nextPlugins.push(packageSpecifier);
  }

  return nextPlugins;
}

export function isPackagePluginSpecifier(value: string): boolean {
  return value === PACKAGE_NAME || value.startsWith(`${PACKAGE_NAME}@`);
}

export function readTuiPluginName(entry: TuiPluginEntry): string {
  return typeof entry === "string" ? entry : entry[0];
}

function isManagedTuiPackageSpecifier(value: string): boolean {
  return (
    isBasePackageSpecifier(value) ||
    value === `${PACKAGE_NAME}/tui` ||
    (value.startsWith(`${PACKAGE_NAME}@`) && value.endsWith("/tui"))
  );
}

export function isTuiPackageSpecifier(value: string): boolean {
  return value === TUI_PACKAGE_SPECIFIER;
}

function isBasePackageSpecifier(value: string): boolean {
  if (value === PACKAGE_NAME) return true;
  const prefix = `${PACKAGE_NAME}@`;
  return value.startsWith(prefix) && !value.slice(prefix.length).includes("/");
}
// END_BLOCK_PARSE_AND_NORMALIZE_CONFIG_VALUES
