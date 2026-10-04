// FILE: src/lib/opencode/cli-plugin-registration.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Mirror-only maintenance of the managed vvoc entry in the native OpenCode TUI client config (cli.json).
//   SCOPE: Reading the global cli.json plugins array, rewriting an existing managed vvoc entry to the pinned specifier with comment-preserving JSONC edits, refusing conflicting managed entries, and reporting the managed client pin versus the server pin; never creates a cli.json document or a plugins array, never touches theme, session, keybind, or other client preferences.
//   DEPENDS: [jsonc-parser, src/lib/package.ts, src/lib/opencode/paths.ts, src/lib/opencode/plugin-registration.ts, src/lib/opencode/shared-utils.ts]
//   LINKS: [M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CLI_CONFIG_SCHEMA_URL - Hosted cli.json schema URL used for documentation only.
//   CLI_CONFIG_FILE_NAME - File name of the native TUI client config inside the global OpenCode config home.
//   ensureCliPackageConfigText - ReWrite an existing managed vvoc entry in cli.json text to the pinned specifier.
//   ensureCliPackageInstalled - Persist the mirrored cli.json pin when a managed entry exists.
//   managedPinOf - The first managed vvoc entry target in a plugins array, or undefined.
//   readCliPluginPin - Bounded read of the cli.json managed pin state without throwing.
//   comparePluginPins - Compare the server and TUI client managed pins for drift reporting.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CLI-JSON-PIN-SYNC-R1 T-001 - Added the mirror-only cli.json pin writer and pin comparison for the TUI client config that the host migrated from V1 tui.json.]
// END_CHANGE_SUMMARY

import { applyEdits, format, modify } from "jsonc-parser";
import { getPinnedPackageSpecifier } from "../package.js";
import type { ResolvedPaths } from "./paths.js";
import { isManagedPackageTarget, normalizePluginEntries } from "./plugin-registration.js";
import {
  ensureTrailingNewline,
  parseObjectDocument,
  readOptionalText,
  readPluginEntries,
  writeText,
  type JsonObject,
  type OpenCodePluginEntry,
} from "./shared-utils.js";

/** Hosted cli.json schema URL; cli documents are never created or schema-tagged by vvoc. */
export const CLI_CONFIG_SCHEMA_URL = "https://opencode.ai/v2/cli.json";

/** File name of the native TUI client config inside the global OpenCode config home. */
export const CLI_CONFIG_FILE_NAME = "cli.json";

const CLI_LABEL = "OpenCode cli config";
const JSON_FORMAT = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const;

/** The first managed vvoc entry target in a plugins array, or undefined. */
export function managedPinOf(entries: readonly OpenCodePluginEntry[]): string | undefined {
  for (const entry of entries) {
    const target = typeof entry === "string" ? entry : entry.package;
    if (isManagedPackageTarget(target)) return target;
  }
  return undefined;
}

// START_BLOCK_MIRROR_ONLY_PIN_SYNC
/**
 * Rewrite an existing managed vvoc entry in cli.json text to the requested
 * specifier. Mirror-only: the TUI also loads plugin entrypoints from the
 * server inventory, so a fresh machine needs no client pin, and vvoc never
 * creates a cli.json document or injects a plugins array. Comments, unrelated
 * keys, unrelated plugin entries, their order, and the managed entry's options
 * are preserved; conflicting managed entries fail loudly like in opencode.json.
 */
export function ensureCliPackageConfigText(
  text: string | undefined,
  packageSpecifier: string,
): string | undefined {
  if (text === undefined || !text.trim()) return undefined;
  const document: JsonObject = parseObjectDocument(text, CLI_LABEL);
  if (!Object.hasOwn(document, "plugins")) return text;
  const currentPlugins = readPluginEntries(document, CLI_LABEL);
  if (managedPinOf(currentPlugins) === undefined) return text;

  const nextPlugins = normalizePluginEntries(currentPlugins, packageSpecifier);
  if (JSON.stringify(nextPlugins) === JSON.stringify(currentPlugins)) return text;

  const edited = applyEdits(
    text,
    modify(text, ["plugins"], nextPlugins, { formattingOptions: JSON_FORMAT }),
  );
  return ensureTrailingNewline(applyEdits(edited, format(edited, undefined, JSON_FORMAT)));
}

/** Persist the mirrored cli.json pin when a managed entry exists; never creates the file. */
export async function ensureCliPackageInstalled(paths: ResolvedPaths): Promise<{
  path: string;
  changed: boolean;
}> {
  const currentText = await readOptionalText(paths.cliConfigPath);
  const nextText = ensureCliPackageConfigText(currentText, await getPinnedPackageSpecifier());
  if (currentText === undefined || nextText === undefined || nextText === currentText) {
    return { path: paths.cliConfigPath, changed: false };
  }
  await writeText(paths.cliConfigPath, nextText);
  return { path: paths.cliConfigPath, changed: true };
}
// END_BLOCK_MIRROR_ONLY_PIN_SYNC

/** Bounded read of the cli.json managed pin state; a parse failure never throws. */
export function readCliPluginPin(text: string | undefined): {
  exists: boolean;
  parseError: string | undefined;
  managedPin: string | undefined;
} {
  if (text === undefined) return { exists: false, parseError: undefined, managedPin: undefined };
  try {
    const document = parseObjectDocument(text, CLI_LABEL);
    const entries = Object.hasOwn(document, "plugins")
      ? readPluginEntries(document, CLI_LABEL)
      : [];
    return { exists: true, parseError: undefined, managedPin: managedPinOf(entries) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exists: true, parseError: message.slice(0, 200), managedPin: undefined };
  }
}

/** Compare the server and TUI client managed pins for drift reporting. */
export function comparePluginPins(
  serverPlugins: readonly OpenCodePluginEntry[],
  cliText: string | undefined,
): {
  serverPin: string | undefined;
  cliExists: boolean;
  cliParseError: string | undefined;
  cliPin: string | undefined;
  mismatch: boolean;
} {
  const serverPin = managedPinOf(serverPlugins);
  const cli = readCliPluginPin(cliText);
  const mismatch =
    cli.parseError === undefined &&
    cli.managedPin !== undefined &&
    serverPin !== undefined &&
    cli.managedPin !== serverPin;
  return {
    serverPin,
    cliExists: cli.exists,
    cliParseError: cli.parseError,
    cliPin: cli.managedPin,
    mismatch,
  };
}
