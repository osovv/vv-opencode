// FILE: src/lib/opencode/model-overrides.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Generic OpenCode agent, default-model, and provider option overrides for any agent or provider id.
//   SCOPE: Read/write model overrides for arbitrary OpenCode agents, the top-level native `model` override with entry ensuring, providers.<id> object merges and settings.baseURL writes. Managed vvoc agent model IO stays in agent-registrations.ts.
//   DEPENDS: [jsonc-parser, src/lib/opencode/shared-utils.ts, src/lib/opencode/paths.ts, src/lib/opencode/agent-registrations.ts]
//   LINKS: [M-CLI-CONFIG, M-CLI-AGENT-MODELS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   OpenCodeDefaultModelKey - Supported top-level OpenCode default model fields.
//   readOpenCodeAgentModel - Reads a model override for any OpenCode agent from config.
//   readOpenCodeAgentOverride - Reads a model override for any OpenCode agent from config.
//   writeOpenCodeAgentModel - Writes or removes a model override for any OpenCode agent in config.
//   readOpenCodeDefaultModel - Reads the top-level native OpenCode model override.
//   writeOpenCodeDefaultModel - Writes or removes the top-level native OpenCode model override.
//   writeOpenCodeProviderObject - Writes or merges a providers.<id> object override.
//   ensureProviderBaseUrlConfigText - Ensures OpenCode config contains the requested provider settings.baseURL override.
//   writeProviderBaseUrl - Writes a provider settings.baseURL override into OpenCode config.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-MODULE-SPLIT - Extracted generic agent/default-model/provider override IO from the former src/lib/opencode.ts monolith into this zone module.]
// END_CHANGE_SUMMARY

import { applyEdits, format, modify } from "jsonc-parser";
import { dirname } from "node:path";
import { isRoleReference } from "../model-roles.js";
import { getPinnedPackageSpecifier } from "../package.js";
import { ensureAgentConfigText, readAgentMap } from "./agent-registrations.js";
import type { ResolvedPaths } from "./paths.js";
import {
  applyModelIntent,
  assertNativeOpenCodeDocument,
  ensureOpenCodeConfigText,
  ensureTrailingNewline,
  isJsonObject,
  mergeJsonObjects,
  normalizeNativeModelSelection,
  OPENCODE_SCHEMA_URL,
  parseObjectDocument,
  readAgentOverride,
  readModelIntentEnvelope,
  readOptionalObject,
  readOptionalText,
  renderJson,
  updateAgentEntryText,
  writeText,
  type JsonObject,
  type NativeValidationContext,
  type WriteResult,
} from "./shared-utils.js";

const JSON_FORMAT = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const;

export type OpenCodeDefaultModelKey = "model" | "small_model";

/** `small_model` has no native 2.0.18 field and is preserved through the modelIntent envelope. */
const ENVELOPE_DEFAULT_MODEL_KEYS: Record<OpenCodeDefaultModelKey, "model" | "smallModel"> = {
  model: "model",
  small_model: "smallModel",
};

export async function readOpenCodeAgentModel(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
  agentName: string,
): Promise<string | undefined> {
  return (await readOpenCodeAgentOverride(paths, agentName)).model;
}

export async function readOpenCodeAgentOverride(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
  agentName: string,
): Promise<{ model?: string }> {
  const currentText = await readOptionalText(paths.opencodeConfigPath);

  if (!currentText) {
    return {};
  }

  const document = parseObjectDocument(currentText, paths.opencodeConfigPath);
  const agentMap = readAgentMap(document, paths.opencodeConfigPath);
  const literal = readAgentOverride(
    agentMap[agentName],
    `${paths.opencodeConfigPath}: agents.${agentName}`,
  );
  if (literal.model !== undefined) {
    return literal;
  }

  const intent = readModelIntentEnvelope(document);
  const intentAgents = intent?.agents;
  if (isJsonObject(intentAgents)) {
    const envelopeModel = intentAgents[agentName];
    if (typeof envelopeModel === "string" && envelopeModel.trim()) {
      return { model: envelopeModel.trim() };
    }
  }

  return {};
}

export async function readOpenCodeDefaultModel(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
  key: OpenCodeDefaultModelKey,
): Promise<string | undefined> {
  const envelopeKey = ENVELOPE_DEFAULT_MODEL_KEYS[key];
  const currentText = await readOptionalText(paths.opencodeConfigPath);

  if (!currentText) {
    return undefined;
  }

  const document = parseObjectDocument(currentText, paths.opencodeConfigPath);

  const nativeValue = document.model;
  if (key === "model" && nativeValue !== undefined) {
    return normalizeNativeModelSelection(nativeValue, `${paths.opencodeConfigPath}: model`);
  }

  const intent = readModelIntentEnvelope(document);
  const envelopeValue = intent?.[envelopeKey];
  return typeof envelopeValue === "string" && envelopeValue.trim()
    ? envelopeValue.trim()
    : undefined;
}

export async function writeOpenCodeAgentModel(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
  agentName: string,
  options: { model?: string; ensureEntry: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.opencodeConfigPath);
  if (!currentText && !options.ensureEntry) {
    return { action: "kept", path: paths.opencodeConfigPath };
  }

  const configDir = dirname(paths.opencodeConfigPath);
  const context = { configDir };
  const baseText = options.ensureEntry
    ? ensureAgentConfigText(currentText, context)
    : (currentText ?? ensureOpenCodeConfigText(currentText, context));
  const specifier = await getPinnedPackageSpecifier();
  const model = options.model?.trim() || undefined;
  let nextText: string;

  if (model !== undefined && isRoleReference(model)) {
    // Role intent never becomes a native model literal; it is preserved in the envelope.
    nextText = clearNativeAgentModel(baseText, paths.opencodeConfigPath, agentName);
    nextText = applyModelIntent(
      nextText,
      specifier,
      paths.opencodeConfigPath,
      {
        agents: { [agentName]: model },
      },
      context,
    );
  } else {
    nextText = updateNativeAgentModel(baseText, paths.opencodeConfigPath, agentName, model);
    nextText = applyModelIntent(
      nextText,
      specifier,
      paths.opencodeConfigPath,
      {
        agents: { [agentName]: null },
      },
      context,
    );
  }

  assertNativeOpenCodeDocument(
    parseObjectDocument(nextText, paths.opencodeConfigPath),
    paths.opencodeConfigPath,
    context,
  );

  if ((currentText ?? "") === nextText) {
    return { action: "kept", path: paths.opencodeConfigPath };
  }

  await writeText(paths.opencodeConfigPath, nextText);
  return {
    action: currentText ? "updated" : "created",
    path: paths.opencodeConfigPath,
  };
}

export async function writeOpenCodeDefaultModel(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
  key: OpenCodeDefaultModelKey,
  options: { model?: string; ensureEntry: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.opencodeConfigPath);
  if (!currentText && !options.ensureEntry) {
    return { action: "kept", path: paths.opencodeConfigPath };
  }

  const context = { configDir: dirname(paths.opencodeConfigPath) };
  const baseText = currentText ?? ensureOpenCodeConfigText(currentText, context);
  const specifier = await getPinnedPackageSpecifier();
  const envelopeKey = ENVELOPE_DEFAULT_MODEL_KEYS[key];
  const model = options.model?.trim() || undefined;
  let nextText: string;

  if (key === "model" && model !== undefined && !isRoleReference(model)) {
    nextText = updateTopLevelStringFieldText(baseText, "model", model);
    nextText = applyModelIntent(
      nextText,
      specifier,
      paths.opencodeConfigPath,
      { model: null },
      context,
    );
  } else {
    if (key === "model") {
      nextText = updateTopLevelStringFieldText(baseText, "model", undefined);
    } else {
      nextText = baseText;
    }
    nextText = applyModelIntent(
      nextText,
      specifier,
      paths.opencodeConfigPath,
      {
        [envelopeKey]: model ?? null,
      } as { model?: string | null; smallModel?: string | null },
      context,
    );
  }

  assertNativeOpenCodeDocument(
    parseObjectDocument(nextText, paths.opencodeConfigPath),
    paths.opencodeConfigPath,
    context,
  );

  if ((currentText ?? "") === nextText) {
    return { action: "kept", path: paths.opencodeConfigPath };
  }

  await writeText(paths.opencodeConfigPath, nextText);
  return {
    action: currentText ? "updated" : "created",
    path: paths.opencodeConfigPath,
  };
}

function updateNativeAgentModel(
  text: string,
  label: string,
  agentName: string,
  model: string | undefined,
): string {
  const document = parseObjectDocument(text, label);
  const agentMap = readAgentMap(document, label);
  const nextEntry = { ...agentMap[agentName] };
  if (model === undefined) delete nextEntry.model;
  else nextEntry.model = model;
  return updateAgentEntryText(text, agentName, nextEntry);
}

function clearNativeAgentModel(text: string, label: string, agentName: string): string {
  const document = parseObjectDocument(text, label);
  const agentMap = readAgentMap(document, label);
  const current = agentMap[agentName];
  if (current === undefined || current.model === undefined) return text;
  const nextEntry = { ...current };
  delete nextEntry.model;
  return updateAgentEntryText(text, agentName, nextEntry);
}

export async function writeOpenCodeProviderObject(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
  providerID: string,
  value: JsonObject,
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.opencodeConfigPath);
  const nextText = ensureProviderObjectConfigText(currentText, providerID, value, {
    configDir: dirname(paths.opencodeConfigPath),
  });

  if ((currentText ?? "") === nextText) {
    return { action: "kept", path: paths.opencodeConfigPath };
  }

  await writeText(paths.opencodeConfigPath, nextText);
  return {
    action: currentText ? "updated" : "created",
    path: paths.opencodeConfigPath,
  };
}

// START_BLOCK_ENSURE_PROVIDER_BASE_URL_CONFIG
export function ensureProviderBaseUrlConfigText(
  text: string | undefined,
  providerID: string,
  baseURL: string,
  context: NativeValidationContext = {},
): string {
  if (!text?.trim()) {
    return renderJson({
      $schema: OPENCODE_SCHEMA_URL,
      providers: {
        [providerID]: {
          settings: {
            baseURL,
          },
        },
      },
    });
  }

  const document = parseObjectDocument(text, "OpenCode config");
  assertNativeOpenCodeDocument(document, "OpenCode config", context);
  const currentProviders = readProviderMap(document, "OpenCode config");
  const currentProvider = currentProviders[providerID];
  const currentSettings = currentProvider
    ? readOptionalObject(currentProvider, "settings", `OpenCode config: providers.${providerID}`)
    : undefined;
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

  if (currentSettings?.baseURL !== baseURL) {
    nextText = applyEdits(
      nextText,
      modify(nextText, ["providers", providerID, "settings", "baseURL"], baseURL, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
}

export async function writeProviderBaseUrl(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
  providerID: string,
  baseURL: string,
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.opencodeConfigPath);
  const nextText = ensureProviderBaseUrlConfigText(currentText, providerID, baseURL, {
    configDir: dirname(paths.opencodeConfigPath),
  });

  if ((currentText ?? "") === nextText) {
    return { action: "kept", path: paths.opencodeConfigPath };
  }

  await writeText(paths.opencodeConfigPath, nextText);
  return {
    action: currentText ? "updated" : "created",
    path: paths.opencodeConfigPath,
  };
}
// END_BLOCK_ENSURE_PROVIDER_BASE_URL_CONFIG

// START_BLOCK_PROVIDER_AND_FIELD_EDITS
function readProviderMap(document: JsonObject, label: string): Record<string, JsonObject> {
  const raw = document.providers;
  if (raw === undefined) {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label}: expected "providers" to be an object`);
  }

  const entries: Record<string, JsonObject> = {};
  for (const [name, value] of Object.entries(raw as JsonObject)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label}: expected "providers.${name}" to be an object`);
    }
    entries[name] = value as JsonObject;
  }
  return entries;
}

function ensureProviderObjectConfigText(
  text: string | undefined,
  providerID: string,
  value: JsonObject,
  context: NativeValidationContext = {},
): string {
  if (!text?.trim()) {
    return renderJson({
      $schema: OPENCODE_SCHEMA_URL,
      providers: {
        [providerID]: value,
      },
    });
  }

  const document = parseObjectDocument(text, "OpenCode config");
  assertNativeOpenCodeDocument(document, "OpenCode config", context);
  const currentProviders = readProviderMap(document, "OpenCode config");
  const currentValue = currentProviders[providerID];
  const nextValue = currentValue ? mergeProviderObject(currentValue, value) : value;
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

  if (JSON.stringify(currentValue) !== JSON.stringify(nextValue)) {
    nextText = applyEdits(
      nextText,
      modify(nextText, ["providers", providerID], nextValue, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
}

/**
 * Merges a vvoc provider patch into the current provider object. Model
 * `variants` arrays are merged by variant id (preserving user-added variants
 * and unowned settings inside a matching variant); every other value keeps the
 * generic deep-merge semantics so no unrelated array behavior changes.
 */
function mergeProviderObject(current: JsonObject, patch: JsonObject): JsonObject {
  const merged: JsonObject = { ...current };
  for (const [key, patchValue] of Object.entries(patch)) {
    const currentValue = merged[key];
    if (key === "models" && isJsonObject(currentValue) && isJsonObject(patchValue)) {
      merged[key] = mergeProviderModels(currentValue, patchValue);
      continue;
    }
    merged[key] =
      isJsonObject(currentValue) && isJsonObject(patchValue)
        ? mergeJsonObjects(currentValue, patchValue)
        : patchValue;
  }
  return merged;
}

function mergeProviderModels(current: JsonObject, patch: JsonObject): JsonObject {
  const merged: JsonObject = { ...current };
  for (const [modelId, patchModel] of Object.entries(patch)) {
    const currentModel = merged[modelId];
    if (isJsonObject(currentModel) && isJsonObject(patchModel)) {
      merged[modelId] = mergeProviderModel(currentModel, patchModel);
      continue;
    }
    merged[modelId] = patchModel;
  }
  return merged;
}

function mergeProviderModel(current: JsonObject, patch: JsonObject): JsonObject {
  const merged: JsonObject = { ...current };
  for (const [key, patchValue] of Object.entries(patch)) {
    const currentValue = merged[key];
    if (key === "variants" && Array.isArray(currentValue) && Array.isArray(patchValue)) {
      merged[key] = mergeModelVariants(currentValue, patchValue);
      continue;
    }
    merged[key] =
      isJsonObject(currentValue) && isJsonObject(patchValue)
        ? mergeJsonObjects(currentValue, patchValue)
        : patchValue;
  }
  return merged;
}

/** Merges native model variant arrays by variant id; user variants and unowned fields survive. */
function mergeModelVariants(current: unknown[], patch: unknown[]): unknown[] {
  const merged: unknown[] = current.map((entry) => (isJsonObject(entry) ? { ...entry } : entry));
  const indexById = new Map<string, number>();
  merged.forEach((entry, index) => {
    if (isJsonObject(entry) && typeof entry.id === "string") indexById.set(entry.id, index);
  });

  for (const patchEntry of patch) {
    const variantId =
      isJsonObject(patchEntry) && typeof patchEntry.id === "string" ? patchEntry.id : undefined;
    const existingIndex = variantId === undefined ? undefined : indexById.get(variantId);
    if (existingIndex === undefined) {
      merged.push(isJsonObject(patchEntry) ? { ...patchEntry } : patchEntry);
      if (variantId !== undefined) indexById.set(variantId, merged.length - 1);
      continue;
    }
    const existing = merged[existingIndex];
    merged[existingIndex] =
      isJsonObject(existing) && isJsonObject(patchEntry)
        ? mergeJsonObjects(existing, patchEntry)
        : patchEntry;
  }
  return merged;
}

function updateTopLevelStringFieldText(
  text: string,
  key: OpenCodeDefaultModelKey,
  value: string | undefined,
): string {
  const nextText = applyEdits(
    text,
    modify(text, [key], value, {
      formattingOptions: JSON_FORMAT,
    }),
  );
  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
}
// END_BLOCK_PROVIDER_AND_FIELD_EDITS
