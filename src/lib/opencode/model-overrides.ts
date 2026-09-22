// FILE: src/lib/opencode/model-overrides.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Generic OpenCode agent, default-model, and provider option overrides for any agent or provider id.
//   SCOPE: Read/write model overrides for arbitrary OpenCode agents, top-level model/small_model overrides with entry ensuring, provider.<id> object merges and options.baseURL writes. Managed vvoc agent model IO stays in agent-registrations.ts.
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
//   readOpenCodeDefaultModel - Reads a top-level OpenCode model or small_model override.
//   writeOpenCodeDefaultModel - Writes or removes a top-level OpenCode model or small_model override.
//   writeOpenCodeProviderObject - Writes or merges a provider.<id> object override.
//   ensureProviderBaseUrlConfigText - Ensures OpenCode config contains the requested provider options.baseURL override.
//   writeProviderBaseUrl - Writes a provider options.baseURL override into OpenCode config.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-MODULE-SPLIT - Extracted generic agent/default-model/provider override IO from the former src/lib/opencode.ts monolith into this zone module.]
// END_CHANGE_SUMMARY

import { applyEdits, format, modify } from "jsonc-parser";
import { ensureAgentConfigText, readAgentMap } from "./agent-registrations.js";
import type { ResolvedPaths } from "./paths.js";
import {
  ensureOpenCodeConfigText,
  ensureTrailingNewline,
  mergeJsonObjects,
  OPENCODE_SCHEMA_URL,
  parseObjectDocument,
  readAgentOverride,
  readNonEmptyString,
  readOptionalObject,
  readOptionalText,
  renderJson,
  updateAgentEntryText,
  writeText,
  type JsonObject,
  type WriteResult,
} from "./shared-utils.js";

const JSON_FORMAT = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const;

export type OpenCodeDefaultModelKey = "model" | "small_model";

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
  return readAgentOverride(agentMap[agentName], `${paths.opencodeConfigPath}: agent.${agentName}`);
}

export async function readOpenCodeDefaultModel(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
  key: OpenCodeDefaultModelKey,
): Promise<string | undefined> {
  const currentText = await readOptionalText(paths.opencodeConfigPath);

  if (!currentText) {
    return undefined;
  }

  const document = parseObjectDocument(currentText, paths.opencodeConfigPath);
  const value = document[key];

  if (value === undefined) {
    return undefined;
  }

  return readNonEmptyString(value, `${paths.opencodeConfigPath}: ${key}`);
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

  const baseText = options.ensureEntry ? ensureAgentConfigText(currentText) : currentText;
  if (!baseText) {
    return { action: "kept", path: paths.opencodeConfigPath };
  }

  const document = parseObjectDocument(baseText, paths.opencodeConfigPath);
  const agentMap = readAgentMap(document, paths.opencodeConfigPath);
  const currentEntry = agentMap[agentName];

  if (!currentEntry && !options.ensureEntry) {
    return { action: "kept", path: paths.opencodeConfigPath };
  }

  const nextEntry = currentEntry ? { ...currentEntry } : {};

  if (options.model) {
    nextEntry.model = options.model;
  } else {
    delete nextEntry.model;
  }

  const nextText = updateAgentEntryText(baseText, agentName, nextEntry);

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

  const baseText = options.ensureEntry ? ensureOpenCodeConfigText(currentText) : currentText;
  if (!baseText) {
    return { action: "kept", path: paths.opencodeConfigPath };
  }

  const nextText = updateTopLevelStringFieldText(baseText, key, options.model);

  if ((currentText ?? "") === nextText) {
    return { action: "kept", path: paths.opencodeConfigPath };
  }

  await writeText(paths.opencodeConfigPath, nextText);
  return {
    action: currentText ? "updated" : "created",
    path: paths.opencodeConfigPath,
  };
}

export async function writeOpenCodeProviderObject(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
  providerID: string,
  value: JsonObject,
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.opencodeConfigPath);
  const nextText = ensureProviderObjectConfigText(currentText, providerID, value);

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
): string {
  if (!text?.trim()) {
    return renderJson({
      $schema: OPENCODE_SCHEMA_URL,
      provider: {
        [providerID]: {
          options: {
            baseURL,
          },
        },
      },
    });
  }

  const document = parseObjectDocument(text, "OpenCode config");
  const currentProviders = readProviderMap(document, "OpenCode config");
  const currentProvider = currentProviders[providerID];
  const currentOptions = currentProvider
    ? readOptionalObject(currentProvider, "options", `OpenCode config: provider.${providerID}`)
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

  if (currentOptions?.baseURL !== baseURL) {
    nextText = applyEdits(
      nextText,
      modify(nextText, ["provider", providerID, "options", "baseURL"], baseURL, {
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
  const nextText = ensureProviderBaseUrlConfigText(currentText, providerID, baseURL);

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
  const raw = document.provider;
  if (raw === undefined) {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label}: expected "provider" to be an object`);
  }

  const entries: Record<string, JsonObject> = {};
  for (const [name, value] of Object.entries(raw as JsonObject)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label}: expected "provider.${name}" to be an object`);
    }
    entries[name] = value as JsonObject;
  }
  return entries;
}

function ensureProviderObjectConfigText(
  text: string | undefined,
  providerID: string,
  value: JsonObject,
): string {
  if (!text?.trim()) {
    return renderJson({
      $schema: OPENCODE_SCHEMA_URL,
      provider: {
        [providerID]: value,
      },
    });
  }

  const document = parseObjectDocument(text, "OpenCode config");
  const currentProviders = readProviderMap(document, "OpenCode config");
  const currentValue = currentProviders[providerID];
  const nextValue = currentValue ? mergeJsonObjects(currentValue, value) : value;
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
      modify(nextText, ["provider", providerID], nextValue, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
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
