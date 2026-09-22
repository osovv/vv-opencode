// FILE: src/lib/opencode/shared-utils.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Private shared JSONC document, value, text, and filesystem helpers plus cross-zone constants used by every src/lib/opencode zone module.
//   SCOPE: JSONC parse/edit primitives with strict object validation, bounded string/array readers, shared role-agnostic agent value readers, managed-file markers, canonical JSON rendering, strict vvoc render-and-write, atomic-ish text IO, write-result shape, and the OpenCode schema URL constants consumed by config-producing zones.
//   DEPENDS: [jsonc-parser, node:fs/promises, node:path, src/lib/vvoc-config.ts]
//   LINKS: [M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CLI_NAME - Canonical vvoc CLI binary name.
//   OPENCODE_SCHEMA_URL - OpenCode config schema URL.
//   OPENCODE_TUI_SCHEMA_URL - OpenCode TUI config schema URL.
//   JsonObject - Internal mutable JSON object shape.
//   WriteResult - Result shape returned by managed config write operations.
//   OpenCodeAgentOverride - Agent override config for OpenCode.
//   parseObjectDocument - Strict JSONC parse returning a top-level object or throwing a labeled error.
//   readStringArray - Reads a required string array with a labeled error.
//   updateAgentEntryText - Rewrites one agent.<name> object with formatting.
//   ensureOpenCodeConfigText - Ensures an OpenCode config document with $schema exists.
//   readNonEmptyString - Reads a required non-empty trimmed string with a labeled error.
//   isJsonObject - Narrows an unknown value to JsonObject.
//   mergeJsonObjects - Deep-merges a patch object into a current object.
//   readOptionalObject - Reads an optional object field with a labeled error.
//   readAgentOverride - Reads the model override from one agent entry.
//   isManagedFile - True when text carries the vvoc managed marker.
//   hasYamlFrontmatter - True when text starts with a YAML frontmatter block.
//   renderJson - Renders a value as canonical two-space JSON with trailing newline.
//   stripMarkdownFrontmatter - Removes a leading YAML frontmatter block.
//   ensureTrailingNewline - Appends a trailing newline when missing.
//   writeResolvedVvocConfig - Renders and writes a vvoc config only when text changed.
//   readOptionalText - Reads a file as text, returning undefined on ENOENT.
//   writeText - Writes text, creating parent directories.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-MODULE-SPLIT - Extracted the shared JSON/value/text/filesystem helper block and cross-zone constants from the former src/lib/opencode.ts monolith into this zone module.]
// END_CHANGE_SUMMARY

import { applyEdits, format, modify, parse, type ParseError } from "jsonc-parser";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { renderVvocConfig, type VvocConfig } from "../vvoc-config.js";

export const CLI_NAME = "vvoc";
export const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";
export const OPENCODE_TUI_SCHEMA_URL = "https://opencode.ai/tui.json";
const MANAGED_MARKER = "Managed by vvoc";

const JSON_FORMAT = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const;

export type JsonObject = Record<string, unknown>;

export type WriteResult = {
  action: "created" | "updated" | "kept" | "skipped";
  path: string;
  reason?: string;
};

export type OpenCodeAgentOverride = { model?: string };

// START_BLOCK_SHARED_DOCUMENT_UTILS
export function parseObjectDocument(text: string, label: string): JsonObject {
  const errors: ParseError[] = [];
  const value = parse(text, errors, {
    allowEmptyContent: false,
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;

  if (errors.length > 0) {
    throw new Error(`${label}: failed to parse JSONC (${errors.length} error(s))`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected a top-level object`);
  }

  return value as JsonObject;
}

export function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label}: expected an array of strings`);
  }
  return value.slice();
}

export function updateAgentEntryText(text: string, agentName: string, entry: JsonObject): string {
  const nextText = applyEdits(
    text,
    modify(text, ["agent", agentName], entry, {
      formattingOptions: JSON_FORMAT,
    }),
  );
  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
}

export function ensureOpenCodeConfigText(text: string | undefined): string {
  if (!text?.trim()) {
    return renderJson({
      $schema: OPENCODE_SCHEMA_URL,
    });
  }

  const document = parseObjectDocument(text, "OpenCode config");
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

  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
}
// END_BLOCK_SHARED_DOCUMENT_UTILS

// START_BLOCK_JSON_VALUE_HELPERS
export function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}: expected a non-empty string`);
  }
  return value.trim();
}

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeJsonObjects(current: JsonObject, patch: JsonObject): JsonObject {
  const merged: JsonObject = { ...current };

  for (const [key, patchValue] of Object.entries(patch)) {
    const currentValue = merged[key];
    merged[key] =
      isJsonObject(currentValue) && isJsonObject(patchValue)
        ? mergeJsonObjects(currentValue, patchValue)
        : patchValue;
  }

  return merged;
}

export function readOptionalObject(
  document: JsonObject,
  key: string,
  label: string,
): JsonObject | undefined {
  const value = document[key];
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected "${key}" to be an object`);
  }
  return value as JsonObject;
}

export function readAgentOverride(
  entry: JsonObject | undefined,
  label: string,
): OpenCodeAgentOverride {
  if (!entry) {
    return {};
  }

  return {
    model:
      entry.model === undefined ? undefined : readNonEmptyString(entry.model, `${label}.model`),
  };
}
// END_BLOCK_JSON_VALUE_HELPERS

// START_BLOCK_FILESYSTEM_HELPERS
export function isManagedFile(text: string): boolean {
  return text.includes(MANAGED_MARKER);
}

export function hasYamlFrontmatter(text: string): boolean {
  return text.startsWith("---\n");
}

export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function stripMarkdownFrontmatter(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n");
  return normalized.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

export function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

export async function writeResolvedVvocConfig(
  path: string,
  currentText: string | undefined,
  config: VvocConfig,
): Promise<WriteResult> {
  const nextText = renderVvocConfig(config);

  if ((currentText ?? "") === nextText) {
    return { action: "kept", path };
  }

  await writeText(path, nextText);
  return {
    action: currentText ? "updated" : "created",
    path,
  };
}

export async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}
// END_BLOCK_FILESYSTEM_HELPERS
