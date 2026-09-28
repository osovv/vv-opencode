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
//   NativeValidationContext - Optional config source directory for {file:} token validation.
//   normalizeNativeModelSelection - Normalizes a native model selection string or struct to provider/model#variant.
//   MODEL_INTENT_OPTION_KEY - Option key on the vvoc plugins entry carrying role intent.
//   isManagedPluginTarget - True when a plugins target is the vvoc base package.
//   ModelIntentPatch - Patch shape for the vvoc plugins modelIntent envelope.
//   applyModelIntent - Applies a modelIntent patch, upgrading string entries in place and preserving other options/order.
//   readModelIntentEnvelope - Reads the vvoc plugins modelIntent envelope from a parsed document.
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

import { Config as NativeConfig } from "@opencode/schema/config";
import { applyEdits, format, modify, parse, type ParseError } from "jsonc-parser";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PACKAGE_NAME } from "../package.js";
import { renderVvocConfig, type VvocConfig } from "../vvoc-config.js";

export const CLI_NAME = "vvoc";
export const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";
/** Option key on the vvoc `plugins` entry that carries root/agent/command role intent. */
export const MODEL_INTENT_OPTION_KEY = "modelIntent";
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

/** True when a plugins target is the vvoc base package (including legacy `/tui`). */
export function isManagedPluginTarget(value: string): boolean {
  return (
    value === PACKAGE_NAME ||
    value.startsWith(`${PACKAGE_NAME}@`) ||
    value === `${PACKAGE_NAME}/tui` ||
    (value.startsWith(`${PACKAGE_NAME}@`) && value.endsWith("/tui"))
  );
}

/** Source context a native document may need to validate `{file:...}` tokens. */
export type NativeValidationContext = { configDir?: string };

const ENV_TOKEN = /\{env:([^}]+)\}/g;
const FILE_TOKEN = /\{file:([^}]+)\}/g;

function hasToken(value: string): boolean {
  return ENV_TOKEN.test(value) || FILE_TOKEN.test(value);
}

/** Replaces native `{env:}`/`{file:}` tokens in one string, mirroring the host substitution. */
function substituteTokenString(
  value: string,
  label: string,
  context: NativeValidationContext,
): string {
  let substituted = value.replace(ENV_TOKEN, (_match, name: string) => process.env[name] ?? "");
  substituted = substituted.replace(FILE_TOKEN, (_match, filePath: string) => {
    if (typeof context.configDir !== "string" || !context.configDir) {
      throw new Error(
        `${label}: cannot validate a {file:} reference without the declaring config directory`,
      );
    }
    const expanded = filePath.startsWith("~/") ? join(homedir(), filePath.slice(2)) : filePath;
    const resolved = isAbsolute(expanded) ? expanded : resolve(context.configDir, expanded);
    try {
      return readFileSync(resolved, "utf8").trim();
    } catch {
      // Value-free diagnostic: never echo resolved paths or file contents.
      throw new Error(`${label}: unresolved {file:} reference`);
    }
  });
  return substituted;
}

/** Builds a substitution-only view; the original document is never rewritten. */
function buildSubstitutedView(
  value: unknown,
  label: string,
  context: NativeValidationContext,
): unknown {
  if (typeof value === "string") {
    return hasToken(value) ? substituteTokenString(value, label, context) : value;
  }
  if (Array.isArray(value))
    return value.map((entry) => buildSubstitutedView(entry, label, context));
  if (value !== null && typeof value === "object") {
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(value as JsonObject)) {
      out[key] = buildSubstitutedView(entry, label, context);
    }
    return out;
  }
  return value;
}

let nativeConfigDecoder: ((input: unknown) => void) | undefined;

/**
 * Decodes a document with the pinned schema package's own Effect 4 codec
 * (resolved through `createRequire` so the schema-owned Effect wins over the
 * root Effect 3 copy). The decoder output is intentionally discarded: native
 * normalization strips unknown user fields, and validation must not serialize it.
 */
function getNativeConfigDecoder(): (input: unknown) => void {
  if (nativeConfigDecoder !== undefined) return nativeConfigDecoder;
  const schemaRequire = createRequire(import.meta.resolve("@opencode/schema/config"));
  const { Schema } = schemaRequire("effect") as {
    Schema: { decodeUnknownSync: (schema: unknown) => (input: unknown) => unknown };
  };
  const decode = Schema.decodeUnknownSync(NativeConfig.Info);
  nativeConfigDecoder = (input: unknown): void => {
    decode(input);
  };
  return nativeConfigDecoder;
}

/**
 * Validate a substituted view against the pinned native codec without leaking
 * values. Substitution is applied first so structural errors (for example a
 * `providers` array) are still rejected even when an unrelated token exists.
 */
function assertNativeSchema(
  document: JsonObject,
  label: string,
  context: NativeValidationContext,
): void {
  const view = buildSubstitutedView(document, label, context);
  try {
    getNativeConfigDecoder()(view);
  } catch {
    // Never surface decoder input/value text; it may contain user secrets.
    throw new Error(
      `${label}: document does not satisfy the pinned native OpenCode 2.0.18 config schema`,
    );
  }
}

/**
 * Normalizes a native model selection (string, or `{providerID, model, variant}`)
 * to the canonical `provider/model#variant` form. Invalid selections are
 * rejected rather than silently defaulted.
 */
export function normalizeNativeModelSelection(
  value: unknown,
  label = "model selection",
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${label}: expected a non-empty model selection`);
    return trimmed;
  }
  if (!isJsonObject(value)) {
    throw new Error(`${label}: expected a model selection string or object`);
  }
  const provider = value.providerID;
  const model = value.model;
  if (typeof provider !== "string" || !provider.trim()) {
    throw new Error(`${label}: expected model selection providerID`);
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new Error(`${label}: expected model selection model id`);
  }
  const variant = value.variant;
  if (variant !== undefined && (typeof variant !== "string" || !variant.trim())) {
    throw new Error(`${label}: expected model selection variant to be a non-empty string`);
  }
  return variant === undefined
    ? `${provider.trim()}/${model.trim()}`
    : `${provider.trim()}/${model.trim()}#${variant.trim()}`;
}

/**
 * Refuse an existing OpenCode document that still uses V1 shapes or fields the
 * pinned native host does not accept, or that the pinned native codec rejects.
 * Called before any config or asset write so an unsupported document is never
 * silently rewritten or migrated.
 */
export function assertNativeOpenCodeDocument(
  document: JsonObject,
  label: string,
  context: NativeValidationContext = {},
): void {
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

  assertNativeSchema(document, label, context);
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

export type ModelIntentPatch = {
  model?: string | null;
  smallModel?: string | null;
  agents?: Record<string, string | null>;
  commands?: Record<string, string | null>;
};

function setOrDeleteIntentValue(
  target: JsonObject,
  key: string,
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null || value === "") {
    delete target[key];
    return;
  }
  target[key] = value;
}

function pruneIntent(intent: JsonObject): void {
  for (const nestedKey of ["agents", "commands"]) {
    const nested = intent[nestedKey];
    if (isJsonObject(nested) && Object.keys(nested).length === 0) delete intent[nestedKey];
  }
}

/**
 * Applies a modelIntent patch to the vvoc-owned `plugins` entry, preserving its
 * options, string-or-object entry form, ordered removal directives, and every
 * unrelated entry. A string managed entry is upgraded in place to an object so
 * a role write cannot append a conflicting duplicate.
 */
export function applyModelIntent(
  text: string,
  specifier: string,
  label: string,
  patch: ModelIntentPatch,
  context: NativeValidationContext = {},
): string {
  const document = parseObjectDocument(text, label);
  assertNativeOpenCodeDocument(document, label, context);
  const entries = readPluginEntries(document, label);
  const index = entries.findIndex((entry) =>
    typeof entry === "string" ? isManagedPluginTarget(entry) : isManagedPluginTarget(entry.package),
  );
  const managed = index === -1 ? undefined : entries[index];
  const options: JsonObject =
    managed && typeof managed === "object" && isJsonObject(managed.options)
      ? { ...managed.options }
      : {};
  const intent: JsonObject = isJsonObject(options[MODEL_INTENT_OPTION_KEY])
    ? { ...(options[MODEL_INTENT_OPTION_KEY] as JsonObject) }
    : {};

  setOrDeleteIntentValue(intent, "model", patch.model);
  setOrDeleteIntentValue(intent, "smallModel", patch.smallModel);
  for (const [groupKey, group] of [
    ["agents", patch.agents],
    ["commands", patch.commands],
  ] as const) {
    if (group === undefined) continue;
    const current = isJsonObject(intent[groupKey]) ? { ...intent[groupKey] } : {};
    for (const [name, value] of Object.entries(group)) setOrDeleteIntentValue(current, name, value);
    if (Object.keys(current).length === 0) delete intent[groupKey];
    else intent[groupKey] = current;
  }
  pruneIntent(intent);
  if (Object.keys(intent).length === 0) delete options[MODEL_INTENT_OPTION_KEY];
  else options[MODEL_INTENT_OPTION_KEY] = intent;

  let nextEntries: OpenCodePluginEntry[];
  if (index === -1) {
    if (options[MODEL_INTENT_OPTION_KEY] === undefined) return text;
    nextEntries = [...entries, { package: specifier, options }];
  } else {
    const nextEntry: { package: string; options?: JsonObject } = { package: specifier };
    if (Object.keys(options).length > 0) nextEntry.options = options;
    nextEntries = entries.map((entry, entryIndex) => (entryIndex === index ? nextEntry : entry));
  }

  const nextText = applyEdits(
    text,
    modify(text, ["plugins"], nextEntries, { formattingOptions: JSON_FORMAT }),
  );
  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
}

/** Reads the vvoc-owned modelIntent envelope, accepting string and object entries. */
export function readModelIntentEnvelope(document: JsonObject): JsonObject | undefined {
  const plugins = document.plugins;
  if (!Array.isArray(plugins)) return undefined;
  for (const entry of plugins) {
    if (!isJsonObject(entry)) continue;
    if (typeof entry.package !== "string" || !isManagedPluginTarget(entry.package)) continue;
    const options = entry.options;
    if (!isJsonObject(options)) continue;
    const intent = options[MODEL_INTENT_OPTION_KEY];
    if (isJsonObject(intent)) return intent;
  }
  return undefined;
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

export function ensureOpenCodeConfigText(
  text: string | undefined,
  context: NativeValidationContext = {},
): string {
  if (!text?.trim()) {
    return renderJson({
      $schema: OPENCODE_SCHEMA_URL,
    });
  }

  const document = parseObjectDocument(text, "OpenCode config");
  assertNativeOpenCodeDocument(document, "OpenCode config", context);
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
    model: normalizeNativeModelSelection(entry.model, `${label}.model`),
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
