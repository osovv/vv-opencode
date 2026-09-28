// FILE: src/lib/opencode/shared-utils.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Private shared native OpenCode JSONC document, value, text, and filesystem helpers plus cross-zone constants used by every src/lib/opencode zone module.
//   SCOPE: JSONC parse/edit primitives with strict object validation, native field readers (`plugins`, `agents`, `skills`, `providers`), V1-shape refusal before mutation, shared agent value readers, managed-file markers, canonical JSON rendering, strict vvoc render-and-write, atomic-ish text IO, write-result shape, and the native OpenCode schema URL constant.
//   DEPENDS: [jsonc-parser, node:fs/promises, node:path, src/lib/vvoc-config.ts]
//   LINKS: [M-CLI-CONFIG, M-CONFIG-LAYERS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CLI_NAME - Canonical vvoc CLI binary name.
//   OPENCODE_SCHEMA_URL - Native OpenCode config schema URL.
//   JsonObject - Internal mutable JSON object shape.
//   WriteResult - Result shape returned by managed config write operations.
//   OpenCodeAgentOverride - Agent override config for OpenCode.
//   OpenCodePluginEntry - Native plugins entry: a target string or a {package, options} object.
//   parseObjectDocument - Strict JSONC parse returning a top-level object or throwing a labeled error.
//   readStringArray - Reads a required string array with a labeled error.
//   assertNativeOpenCodeDocument - Refuses V1-shaped or unsupported documents before any mutation.
//   readPluginEntries - Reads the native `plugins` array preserving string and {package, options} entries.
//   readSkillsArray - Reads the native `skills` string array.
//   readNativeAgents - Reads the native `agents` record with labeled object validation.
//   updateAgentEntryText - Rewrites one `agents.<name>` object with formatting.
//   ensureOpenCodeConfigText - Ensures an OpenCode config document with $schema exists.
//   readNonEmptyString - Reads a required non-empty trimmed string with a labeled error.
//   isJsonObject - Narrows an unknown value to JsonObject.
//   mergeJsonObjects - Deep-merges a patch object into a current object.
//   readOptionalObject - Reads an optional object field with a labeled error.
//   readAgentOverride - Reads the model override from one native agent entry.
//   isManagedFile - True when text carries the vvoc managed marker.
//   hasYamlFrontmatter - True when text starts with a YAML frontmatter block.
//   renderJson - Renders a value as canonical two-space JSON with trailing newline.
//   stripMarkdownFrontmatter - Removes a leading YAML frontmatter block.
//   ensureTrailingNewline - Appends a trailing newline when missing.
//   writeResolvedVvocConfig - Renders and writes a vvoc config only when text changed.
//   readOptionalText - Reads a file as text, returning undefined on ENOENT.
//   writeText - Writes text, creating parent directories.
//   removeTextFile - Removes a file when present, ignoring ENOENT.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-007 - Migrated the shared document layer to native OpenCode 2.0.18 fields (`plugins`, `agents`, `skills`, `providers`) and added V1-shape refusal before mutation.]
// END_CHANGE_SUMMARY

import { applyEdits, format, modify, parse, type ParseError } from "jsonc-parser";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { renderVvocConfig, type VvocConfig } from "../vvoc-config.js";

export const CLI_NAME = "vvoc";
export const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";
const MANAGED_MARKER = "Managed by vvoc";

const JSON_FORMAT = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const;

export type JsonObject = Record<string, unknown>;

export type WriteResult = {
  action: "created" | "updated" | "kept" | "skipped" | "deleted";
  path: string;
  reason?: string;
};

export type OpenCodeAgentOverride = { model?: string };

/** Native `plugins` entry: a package target string, a `-target` removal directive, or a package object with options. */
export type OpenCodePluginEntry =
  | string
  | {
      package: string;
      options?: JsonObject;
    };

/** Native top-level fields that V1 used but 2.0.18 removed or renamed. */
const LEGACY_TOP_LEVEL_FIELDS: readonly { key: string; replacement: string }[] = [
  { key: "plugin", replacement: "plugins" },
  { key: "agent", replacement: "agents" },
  { key: "provider", replacement: "providers" },
  { key: "command", replacement: "commands" },
];

/** V1 agent fields that native `agents.<id>` rejects. */
const LEGACY_AGENT_FIELDS = ["prompt", "permission", "tools"] as const;

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

/**
 * Refuse an existing OpenCode document that still uses V1 shapes or fields the
 * pinned native host does not accept. Called before any config or asset write
 * so an unsupported document is never silently rewritten or migrated.
 */
export function assertNativeOpenCodeDocument(document: JsonObject, label: string): void {
  for (const { key, replacement } of LEGACY_TOP_LEVEL_FIELDS) {
    if (Object.hasOwn(document, key)) {
      throw new Error(
        `${label}: unsupported V1 field "${key}"; native OpenCode 2.0.18 uses "${replacement}"`,
      );
    }
  }

  if (Object.hasOwn(document, "small_model")) {
    throw new Error(
      `${label}: unsupported V1 field "small_model"; native OpenCode 2.0.18 has no small-model config`,
    );
  }

  if (Object.hasOwn(document, "tools")) {
    throw new Error(
      `${label}: unsupported V1 field "tools"; native OpenCode 2.0.18 configures tool access through agent permissions`,
    );
  }

  if (Object.hasOwn(document, "skills")) {
    readSkillsArray(document, label);
  }

  if (Object.hasOwn(document, "plugins")) {
    readPluginEntries(document, label);
  }

  const agents = readNativeAgents(document, label);
  for (const [name, entry] of Object.entries(agents)) {
    for (const legacyField of LEGACY_AGENT_FIELDS) {
      if (Object.hasOwn(entry, legacyField)) {
        throw new Error(
          `${label}: unsupported V1 field "agents.${name}.${legacyField}"; use native agent fields`,
        );
      }
    }
    const model = entry.model;
    if (typeof model === "string" && model.trim().startsWith("vv-role:")) {
      throw new Error(
        `${label}: unsupported role reference in "agents.${name}.model"; use the vvoc plugins modelIntent envelope`,
      );
    }
  }

  const rootModel = document.model;
  if (typeof rootModel === "string" && rootModel.trim().startsWith("vv-role:")) {
    throw new Error(
      `${label}: unsupported role reference in "model"; use the vvoc plugins modelIntent envelope`,
    );
  }
}

export function readPluginEntries(document: JsonObject, label: string): OpenCodePluginEntry[] {
  const raw = document.plugins;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`${label}: expected "plugins" to be an array`);
  }

  return raw.map((entry, index) => {
    if (typeof entry === "string") return entry;
    if (isJsonObject(entry)) {
      const packageName = entry.package;
      if (typeof packageName !== "string" || !packageName.trim()) {
        throw new Error(`${label}: expected "plugins[${index}].package" to be a non-empty string`);
      }
      if (entry.options !== undefined && !isJsonObject(entry.options)) {
        throw new Error(`${label}: expected "plugins[${index}].options" to be an object`);
      }
      return entry.options === undefined
        ? { package: packageName }
        : { package: packageName, options: entry.options };
    }
    throw new Error(
      `${label}: expected "plugins[${index}]" to be a package string or {package, options} object`,
    );
  });
}

export function readSkillsArray(document: JsonObject, label: string): string[] {
  const raw = document.skills;
  if (raw === undefined) return [];
  return readStringArray(raw, `${label}: skills`);
}

export function readNativeAgents(document: JsonObject, label: string): Record<string, JsonObject> {
  const raw = document.agents;
  if (raw === undefined) return {};
  if (!isJsonObject(raw)) {
    throw new Error(`${label}: expected "agents" to be an object`);
  }

  const entries: Record<string, JsonObject> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isJsonObject(value)) {
      throw new Error(`${label}: expected "agents.${name}" to be an object`);
    }
    entries[name] = value;
  }
  return entries;
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
    modify(text, ["agents", agentName], entry, {
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
  assertNativeOpenCodeDocument(document, "OpenCode config");
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

export async function removeTextFile(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
// END_BLOCK_FILESYSTEM_HELPERS
