// FILE: src/lib/opencode.ts
// VERSION: 0.8.0
// START_MODULE_CONTRACT
//   PURPOSE: Manage OpenCode config mutation, provider patching, and the canonical vvoc.json config file.
//   SCOPE: Scope-aware path resolution, pinned plugin writes, top-level OpenCode model/default writes, provider baseURL patching, managed OpenCode agent registration/model overrides, managed agent prompt sync, version-aware canonical vvoc config rendering and sync, and installation inspection.
//   DEPENDS: [jsonc-parser, node:fs/promises, node:path, src/lib/managed-agents.ts, src/lib/package.ts, src/lib/vvoc-config.ts, src/lib/vvoc-paths.ts]
//   LINKS: [M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CLI_NAME - Canonical vvoc CLI binary name.
//   PACKAGE_NAME - Canonical vvoc npm package name.
//   OPENCODE_SCHEMA_URL - OpenCode config schema URL.
//   OpenCodeDefaultModelKey - Supported top-level OpenCode default model fields.
//   Scope - Supported installation scopes for vvoc config writes.
//   ResolvedPaths - Scope-aware path bundle for OpenCode and vvoc config locations.
//   WriteResult - Result shape returned by managed config write operations.
//   InstallationInspection - Current OpenCode and vvoc installation status snapshot.
//   resolvePaths - Resolves OpenCode and vvoc config paths for global/project scopes.
//   ensurePackageConfigText - Ensures OpenCode config contains the pinned vvoc plugin specifier.
//   readOpenCodeDefaultModel - Reads a top-level OpenCode model or small_model override.
//   writeOpenCodeDefaultModel - Writes or removes a top-level OpenCode model or small_model override.
//   ensureProviderBaseUrlConfigText - Ensures OpenCode config contains the requested provider options.baseURL override.
//   ensureManagedAgentRegistrationsConfigText - Ensures OpenCode config contains the vvoc-managed OpenCode agent registrations.
//   readVvocConfig - Loads the canonical vvoc.json document when present.
//   ensurePackageInstalled - Writes the pinned vvoc plugin specifier into OpenCode config.
//   installVvocConfig - Creates or refreshes the canonical vvoc.json document.
//   syncVvocConfig - Rewrites the canonical vvoc.json document while preserving valid current values.
//   writeProviderBaseUrl - Writes a provider options.baseURL override into OpenCode config.
//   syncManagedAgentRegistrations - Syncs the canonical vvoc-managed OpenCode agent registrations into OpenCode config.
//   installManagedAgentPrompts - Creates managed vvoc prompt files for the bundled Guardian and managed OpenCode agents when missing.
//   syncManagedAgentPrompts - Rewrites managed vvoc prompt files for the bundled Guardian and managed OpenCode agents.
//   readOpenCodeAgentModel - Reads a model override for any OpenCode agent from config.
//   writeOpenCodeAgentModel - Writes or removes a model override for any OpenCode agent in config.
//   readManagedAgentModels - Reads model overrides for the bundled vvoc-managed OpenCode agents from OpenCode config.
//   writeManagedAgentModel - Writes or removes a bundled vvoc-managed OpenCode agent model override in OpenCode config.
//   writeGuardianConfig - Writes the guardian section into the canonical vvoc.json document.
//   writeMemoryConfig - Writes the memory section into the canonical vvoc.json document.
//   inspectInstallation - Reads current OpenCode/vvoc installation state for status and doctor commands.
//   describeWriteResult - Formats config write outcomes for CLI output.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.8.0 - Added top-level OpenCode model and small_model read-write helpers for default model switching.]
// END_CHANGE_SUMMARY

import { applyEdits, format, modify, parse, type ParseError } from "jsonc-parser";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  MANAGED_AGENT_PROMPT_NAMES,
  MANAGED_OPENCODE_AGENTS,
  type ManagedAgentPromptName,
  getManagedAgentPromptPath,
  getManagedOpenCodeAgentDefinition,
  loadManagedAgentPromptTemplate,
  type ManagedOpenCodeAgentName,
} from "./managed-agents.js";
import {
  createDefaultVvocConfig,
  createGuardianConfig,
  createMemoryConfig,
  parseVersionedVvocConfigText,
  parseVvocConfigText,
  renderVvocConfig,
  type GuardianConfig,
  type GuardianConfigOverrides,
  type MemoryConfig,
  type MemoryConfigOverrides,
  type SecretsRedactionConfig,
  type VvocConfig,
} from "./vvoc-config.js";
import { getPinnedPackageSpecifier, PACKAGE_NAME } from "./package.js";
import {
  getConfigHome,
  getGlobalOpencodeDir,
  getGlobalVvocConfigPath,
  getGlobalVvocDir,
  getProjectVvocDir,
  getVvocAgentsDir,
} from "./vvoc-paths.js";

export const CLI_NAME = "vvoc";
export { PACKAGE_NAME };
export const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";
const MANAGED_MARKER = "Managed by vvoc";
const OPENCODE_CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;

const JSON_FORMAT = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const;

type JsonObject = Record<string, unknown>;
export type OpenCodeDefaultModelKey = "model" | "small_model";

export type Scope = "global" | "project";

export type ResolvedPaths = {
  scope: Scope;
  cwd: string;
  configHome: string;
  opencodeBaseDir: string;
  vvocBaseDir: string;
  vvocConfigPath: string;
  managedAgentsDirPath: string;
  opencodeConfigPath: string;
  opencodeAlternatePaths: string[];
};

export type WriteResult = {
  action: "created" | "updated" | "kept" | "skipped";
  path: string;
  reason?: string;
};

export type ManagedAgentModelMap = Record<ManagedOpenCodeAgentName, string | undefined>;

export type InstallationInspection = {
  scope: Scope;
  opencode: {
    path: string;
    exists: boolean;
    alternates: string[];
    parseError?: string;
    pluginConfigured: boolean;
    plugins: string[];
  };
  vvoc: {
    path: string;
    exists: boolean;
    parseError?: string;
    schema?: string;
    version?: number;
  };
  guardian: {
    config?: GuardianConfig;
  };
  memory: {
    config?: MemoryConfig;
  };
  secretsRedaction: {
    config?: SecretsRedactionConfig;
  };
  warnings: string[];
  problems: string[];
};

// START_BLOCK_RESOLVE_CONFIG_PATHS
export async function resolvePaths(options: {
  scope: Scope;
  cwd: string;
  configDir?: string;
}): Promise<ResolvedPaths> {
  const configHome = getConfigHome(options.configDir);
  const vvocBaseDir = getGlobalVvocDir(options.configDir);
  const opencodeBaseDir =
    options.scope === "global" ? getGlobalOpencodeDir(options.configDir) : options.cwd;
  const managedAgentsBaseDir =
    options.scope === "global" ? vvocBaseDir : getProjectVvocDir(options.cwd);
  const managedAgentsDirPath = getVvocAgentsDir(managedAgentsBaseDir);
  const opencodeSelection = await selectPrimaryPath(
    OPENCODE_CONFIG_FILE_NAMES.map((name) => join(opencodeBaseDir, name)),
  );

  return {
    scope: options.scope,
    cwd: options.cwd,
    configHome,
    opencodeBaseDir,
    vvocBaseDir,
    vvocConfigPath: getGlobalVvocConfigPath(options.configDir),
    managedAgentsDirPath,
    opencodeConfigPath: opencodeSelection.primary,
    opencodeAlternatePaths: opencodeSelection.alternates,
  };
}
// END_BLOCK_RESOLVE_CONFIG_PATHS

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

// START_BLOCK_ENSURE_MANAGED_AGENT_CONFIG
export function ensureManagedAgentRegistrationsConfigText(
  text: string | undefined,
  paths: Pick<ResolvedPaths, "managedAgentsDirPath" | "opencodeConfigPath">,
): string {
  if (!text?.trim()) {
    return renderJson({
      $schema: OPENCODE_SCHEMA_URL,
      agent: Object.fromEntries(
        MANAGED_OPENCODE_AGENTS.map((definition) => [
          definition.name,
          getManagedOpenCodeAgentRegistration(paths, definition.name),
        ]),
      ),
    });
  }

  const document = parseObjectDocument(text, "OpenCode config");
  const currentAgents = readAgentMap(document, "OpenCode config");
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

  for (const definition of MANAGED_OPENCODE_AGENTS) {
    const currentEntry = currentAgents[definition.name];
    const nextEntry = {
      ...getManagedOpenCodeAgentRegistration(paths, definition.name),
      ...currentEntry,
    };

    if (JSON.stringify(currentEntry) === JSON.stringify(nextEntry)) {
      continue;
    }

    nextText = applyEdits(
      nextText,
      modify(nextText, ["agent", definition.name], nextEntry, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
}

export async function syncManagedAgentRegistrations(paths: ResolvedPaths): Promise<{
  path: string;
  changed: boolean;
}> {
  const currentText = await readOptionalText(paths.opencodeConfigPath);
  const nextText = ensureManagedAgentRegistrationsConfigText(currentText, paths);

  if (currentText === nextText) {
    return { path: paths.opencodeConfigPath, changed: false };
  }

  await writeText(paths.opencodeConfigPath, nextText);
  return { path: paths.opencodeConfigPath, changed: true };
}
// END_BLOCK_ENSURE_MANAGED_AGENT_CONFIG

export async function installManagedAgentPrompts(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];

  for (const agentName of MANAGED_AGENT_PROMPT_NAMES) {
    const promptPath = getManagedPromptPath(paths, agentName);
    const currentText = await readOptionalText(promptPath);
    if (!currentText) {
      await writeText(promptPath, await renderManagedPrompt(agentName));
      results.push({ action: "created", path: promptPath });
      continue;
    }

    if (!options.force) {
      if (!isManagedFile(currentText)) {
        results.push({
          action: "skipped",
          path: promptPath,
          reason: "existing file is not managed by vvoc",
        });
      } else {
        results.push({ action: "kept", path: promptPath });
      }
      continue;
    }

    results.push(await syncManagedPrompt(paths, agentName, options));
  }

  return results;
}

export async function syncManagedAgentPrompts(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];

  for (const agentName of MANAGED_AGENT_PROMPT_NAMES) {
    results.push(await syncManagedPrompt(paths, agentName, options));
  }

  return results;
}

export async function readManagedAgentModels(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
): Promise<ManagedAgentModelMap> {
  const models = Object.fromEntries(
    MANAGED_OPENCODE_AGENTS.map((definition) => [definition.name, undefined]),
  ) as ManagedAgentModelMap;
  const currentText = await readOptionalText(paths.opencodeConfigPath);

  if (!currentText) {
    return models;
  }

  const document = parseObjectDocument(currentText, paths.opencodeConfigPath);
  const agentMap = readAgentMap(document, paths.opencodeConfigPath);

  for (const definition of MANAGED_OPENCODE_AGENTS) {
    const currentEntry = agentMap[definition.name];
    if (currentEntry?.model !== undefined) {
      models[definition.name] = readNonEmptyString(currentEntry.model, `${definition.name}: model`);
    }
  }

  return models;
}

export async function readOpenCodeAgentModel(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
  agentName: string,
): Promise<string | undefined> {
  const currentText = await readOptionalText(paths.opencodeConfigPath);

  if (!currentText) {
    return undefined;
  }

  const document = parseObjectDocument(currentText, paths.opencodeConfigPath);
  const agentMap = readAgentMap(document, paths.opencodeConfigPath);
  const currentEntry = agentMap[agentName];

  if (currentEntry?.model === undefined) {
    return undefined;
  }

  return readNonEmptyString(
    currentEntry.model,
    `${paths.opencodeConfigPath}: agent.${agentName}.model`,
  );
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

export async function writeManagedAgentModel(
  paths: Pick<ResolvedPaths, "managedAgentsDirPath" | "opencodeConfigPath">,
  agentName: ManagedOpenCodeAgentName,
  options: { model?: string; ensureEntry: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.opencodeConfigPath);
  if (!currentText && !options.ensureEntry) {
    return { action: "kept", path: paths.opencodeConfigPath };
  }

  const baseText = options.ensureEntry
    ? ensureManagedAgentRegistrationsConfigText(currentText, paths)
    : currentText;
  if (!baseText) {
    return { action: "kept", path: paths.opencodeConfigPath };
  }

  const document = parseObjectDocument(baseText, paths.opencodeConfigPath);
  const agentMap = readAgentMap(document, paths.opencodeConfigPath);
  const currentEntry = agentMap[agentName];

  if (!currentEntry && !options.ensureEntry) {
    return { action: "kept", path: paths.opencodeConfigPath };
  }

  const nextEntry = {
    ...getManagedOpenCodeAgentRegistration(paths, agentName),
    ...currentEntry,
  };

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
// END_BLOCK_ENSURE_MANAGED_SUBAGENT_CONFIG

export {
  parseGuardianConfigText,
  renderGuardianConfig,
  type GuardianConfigOverrides,
} from "./vvoc-config.js";

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

export async function readVvocConfig(
  paths: Pick<ResolvedPaths, "vvocConfigPath">,
): Promise<VvocConfig | undefined> {
  const currentText = await readOptionalText(paths.vvocConfigPath);
  return currentText ? parseVvocConfigText(currentText, paths.vvocConfigPath) : undefined;
}

export async function installVvocConfig(
  paths: Pick<ResolvedPaths, "vvocConfigPath">,
): Promise<WriteResult> {
  return syncVvocConfig(paths);
}

export async function syncVvocConfig(
  paths: Pick<ResolvedPaths, "vvocConfigPath">,
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.vvocConfigPath);
  const nextConfig = currentText
    ? parseVvocConfigText(currentText, paths.vvocConfigPath)
    : createDefaultVvocConfig();
  return writeResolvedVvocConfig(paths.vvocConfigPath, currentText, nextConfig);
}

export async function writeGuardianConfig(
  paths: Pick<ResolvedPaths, "vvocConfigPath">,
  overrides: GuardianConfigOverrides,
  options: { merge?: boolean } = {},
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.vvocConfigPath);
  const currentConfig = currentText
    ? parseVvocConfigText(currentText, paths.vvocConfigPath)
    : createDefaultVvocConfig();
  const nextConfig: VvocConfig = {
    ...currentConfig,
    guardian: options.merge
      ? createGuardianConfig({ ...currentConfig.guardian, ...overrides })
      : createGuardianConfig(overrides),
  };

  return writeResolvedVvocConfig(paths.vvocConfigPath, currentText, nextConfig);
}
// END_BLOCK_INSTALL_PACKAGE_AND_GUARDIAN_CONFIG

// START_BLOCK_INSTALL_MEMORY_CONFIG
export { type MemoryConfigOverrides } from "./vvoc-config.js";

export async function writeMemoryConfig(
  paths: Pick<ResolvedPaths, "vvocConfigPath">,
  overrides: MemoryConfigOverrides,
  options: { merge?: boolean } = {},
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.vvocConfigPath);
  const currentConfig = currentText
    ? parseVvocConfigText(currentText, paths.vvocConfigPath)
    : createDefaultVvocConfig();
  const nextConfig: VvocConfig = {
    ...currentConfig,
    memory: options.merge
      ? createMemoryConfig({ ...currentConfig.memory, ...overrides })
      : createMemoryConfig(overrides),
  };

  return writeResolvedVvocConfig(paths.vvocConfigPath, currentText, nextConfig);
}
// END_BLOCK_INSTALL_MEMORY_CONFIG

// START_BLOCK_INSPECT_INSTALLATION_STATE
export async function inspectInstallation(paths: ResolvedPaths): Promise<InstallationInspection> {
  const warnings: string[] = [];
  const problems: string[] = [];

  if (paths.opencodeAlternatePaths.length > 0) {
    warnings.push(
      `multiple OpenCode config files exist: ${[paths.opencodeConfigPath, ...paths.opencodeAlternatePaths].join(", ")}`,
    );
  }

  const opencodeText = await readOptionalText(paths.opencodeConfigPath);
  let opencodeParseError: string | undefined;
  let plugins: string[] = [];
  let pluginConfigured = false;

  if (opencodeText) {
    try {
      const document = parseObjectDocument(opencodeText, paths.opencodeConfigPath);
      plugins = readPluginList(document, paths.opencodeConfigPath);
      pluginConfigured = plugins.some(isPackagePluginSpecifier);
    } catch (error) {
      opencodeParseError = error instanceof Error ? error.message : String(error);
      problems.push(opencodeParseError);
    }
  }

  const vvocText = await readOptionalText(paths.vvocConfigPath);
  let vvocParseError: string | undefined;
  let vvocConfig: VvocConfig | undefined;
  let vvocSourceSchema: string | undefined;
  let vvocSourceVersion: number | undefined;

  if (vvocText) {
    try {
      const parsedConfig = parseVersionedVvocConfigText(vvocText, paths.vvocConfigPath);
      vvocConfig = parsedConfig.config;
      vvocSourceSchema = parsedConfig.sourceSchema;
      vvocSourceVersion = parsedConfig.sourceVersion;
    } catch (error) {
      vvocParseError = error instanceof Error ? error.message : String(error);
      problems.push(vvocParseError);
    }
  }

  if (!pluginConfigured) {
    problems.push(`${PACKAGE_NAME} is not configured in ${paths.opencodeConfigPath}`);
  }
  if (!vvocText) {
    problems.push(`vvoc config is missing at ${paths.vvocConfigPath}`);
  }

  return {
    scope: paths.scope,
    opencode: {
      path: paths.opencodeConfigPath,
      exists: Boolean(opencodeText),
      alternates: paths.opencodeAlternatePaths,
      parseError: opencodeParseError,
      pluginConfigured,
      plugins,
    },
    vvoc: {
      path: paths.vvocConfigPath,
      exists: Boolean(vvocText),
      parseError: vvocParseError,
      schema: vvocSourceSchema,
      version: vvocSourceVersion,
    },
    guardian: {
      config: vvocConfig?.guardian,
    },
    memory: {
      config: vvocConfig?.memory,
    },
    secretsRedaction: {
      config: vvocConfig?.secretsRedaction,
    },
    warnings,
    problems,
  };
}
// END_BLOCK_INSPECT_INSTALLATION_STATE

export function describeWriteResult(result: WriteResult): string {
  let message = "";

  switch (result.action) {
    case "created":
      message = `Created ${result.path}`;
      break;
    case "updated":
      message = `Updated ${result.path}`;
      break;
    case "kept":
      message = `Kept ${result.path}`;
      break;
    case "skipped":
      message = `Skipped ${result.path}`;
      break;
  }

  return result.reason ? `${message} (${result.reason})` : message;
}

// START_BLOCK_PARSE_AND_NORMALIZE_CONFIG_VALUES
function parseObjectDocument(text: string, label: string): JsonObject {
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

function readPluginList(document: JsonObject, label: string): string[] {
  const raw = document.plugin;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label}: expected "plugin" to be an array of strings`);
  }
  return raw.slice();
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

function isPackagePluginSpecifier(value: string): boolean {
  return value === PACKAGE_NAME || value.startsWith(`${PACKAGE_NAME}@`);
}

// START_BLOCK_MANAGED_AGENT_HELPERS
function readAgentMap(document: JsonObject, label: string): Record<string, JsonObject> {
  const raw = document.agent;
  if (raw === undefined) {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label}: expected "agent" to be an object`);
  }

  const entries: Record<string, JsonObject> = {};
  for (const [name, value] of Object.entries(raw as JsonObject)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label}: expected "agent.${name}" to be an object`);
    }
    entries[name] = value as JsonObject;
  }
  return entries;
}

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

function getManagedPromptPath(
  paths: Pick<ResolvedPaths, "managedAgentsDirPath">,
  agentName: ManagedAgentPromptName,
): string {
  return getManagedAgentPromptPath(paths.managedAgentsDirPath, agentName);
}

function ensureAgentConfigText(text: string | undefined): string {
  const nextText = ensureOpenCodeConfigText(text);
  const document = parseObjectDocument(nextText, "OpenCode config");
  const currentAgents = readAgentMap(document, "OpenCode config");
  let nextAgentText = nextText;

  if (!Object.hasOwn(document, "agent")) {
    nextAgentText = applyEdits(
      nextAgentText,
      modify(nextAgentText, ["agent"], currentAgents, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  return ensureTrailingNewline(
    applyEdits(nextAgentText, format(nextAgentText, undefined, JSON_FORMAT)),
  );
}

function getManagedOpenCodeAgentPromptReference(
  paths: Pick<ResolvedPaths, "managedAgentsDirPath" | "opencodeConfigPath">,
  agentName: ManagedOpenCodeAgentName,
): string {
  const promptPath = getManagedPromptPath(paths, agentName);
  const promptRef = relative(dirname(paths.opencodeConfigPath), promptPath).replaceAll("\\", "/");
  return `{file:${promptRef.startsWith(".") ? promptRef : `./${promptRef}`}}`;
}

function getManagedOpenCodeAgentRegistration(
  paths: Pick<ResolvedPaths, "managedAgentsDirPath" | "opencodeConfigPath">,
  agentName: ManagedOpenCodeAgentName,
): JsonObject {
  const definition = getManagedOpenCodeAgentDefinition(agentName);
  const registration: JsonObject = {
    description: definition.description,
    mode: definition.mode,
    prompt: getManagedOpenCodeAgentPromptReference(paths, agentName),
  };

  if (definition.permission) {
    registration.permission = definition.permission;
  }

  return registration;
}

async function renderManagedPrompt(agentName: ManagedAgentPromptName): Promise<string> {
  const template = stripMarkdownFrontmatter(await loadManagedAgentPromptTemplate(agentName)).trim();
  const header = [
    "<!-- Managed by vvoc.",
    "`vvoc sync` rewrites files with this marker while preserving agent registration and model settings elsewhere.",
    "Remove this comment if you want to manage the file manually.",
    "-->",
    "",
  ].join("\n");
  return `${header}${template}\n`;
}

async function syncManagedPrompt(
  paths: ResolvedPaths,
  agentName: ManagedAgentPromptName,
  options: { force: boolean },
): Promise<WriteResult> {
  const promptPath = getManagedPromptPath(paths, agentName);
  const currentText = await readOptionalText(promptPath);
  if (!currentText) {
    await writeText(promptPath, await renderManagedPrompt(agentName));
    return { action: "created", path: promptPath };
  }

  if (!options.force && !isManagedFile(currentText)) {
    return {
      action: "skipped",
      path: promptPath,
      reason: "existing file is not managed by vvoc",
    };
  }

  const nextText = await renderManagedPrompt(agentName);
  if (currentText === nextText) {
    return { action: "kept", path: promptPath };
  }

  await writeText(promptPath, nextText);
  return { action: "updated", path: promptPath };
}

function updateAgentEntryText(text: string, agentName: string, entry: JsonObject): string {
  const nextText = applyEdits(
    text,
    modify(text, ["agent", agentName], entry, {
      formattingOptions: JSON_FORMAT,
    }),
  );
  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
}

function ensureOpenCodeConfigText(text: string | undefined): string {
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
// END_BLOCK_MANAGED_AGENT_HELPERS

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}: expected a non-empty string`);
  }
  return value.trim();
}

function readOptionalObject(
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
// END_BLOCK_PARSE_AND_NORMALIZE_CONFIG_VALUES

// START_BLOCK_FILESYSTEM_HELPERS
function isManagedFile(text: string): boolean {
  return text.includes(MANAGED_MARKER);
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stripMarkdownFrontmatter(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n");
  return normalized.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

async function writeResolvedVvocConfig(
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

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function selectPrimaryPath(candidates: string[]): Promise<{
  primary: string;
  alternates: string[];
}> {
  const existing: string[] = [];

  for (const candidate of candidates) {
    if ((await readOptionalText(candidate)) !== undefined) {
      existing.push(candidate);
    }
  }

  return {
    primary: existing[0] ?? candidates[0],
    alternates: existing.slice(1),
  };
}
// END_BLOCK_FILESYSTEM_HELPERS
