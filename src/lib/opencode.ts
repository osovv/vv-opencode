// FILE: src/lib/opencode.ts
// VERSION: 0.2.9
// START_MODULE_CONTRACT
//   PURPOSE: Manage OpenCode config mutation, provider patching, and vvoc-owned config files.
//   SCOPE: Scope-aware path resolution, pinned plugin writes, provider baseURL patching, OpenCode agent model overrides, managed subagent registration, managed agent prompt sync, Guardian/Memory config rendering and sync, and installation inspection.
//   DEPENDS: [jsonc-parser, node:fs/promises, node:path, src/lib/managed-agents.ts, src/lib/package.ts, src/lib/vvoc-paths.ts, src/plugins/memory-store.ts]
//   LINKS: [M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CLI_NAME - Canonical vvoc CLI binary name.
//   PACKAGE_NAME - Canonical vvoc npm package name.
//   OPENCODE_SCHEMA_URL - OpenCode config schema URL.
//   Scope - Supported installation scopes for vvoc config writes.
//   ResolvedPaths - Scope-aware path bundle for OpenCode and vvoc config locations.
//   GuardianConfigOverrides - Guardian config override shape parsed from managed JSONC.
//   WriteResult - Result shape returned by managed config write operations.
//   InstallationInspection - Current OpenCode and vvoc installation status snapshot.
//   resolvePaths - Resolves OpenCode and vvoc config paths for global/project scopes.
//   ensurePackageConfigText - Ensures OpenCode config contains the pinned vvoc plugin specifier.
//   ensureProviderBaseUrlConfigText - Ensures OpenCode config contains the requested provider options.baseURL override.
//   ensureManagedSubagentsConfigText - Ensures OpenCode config contains the vvoc-managed subagent registrations.
//   parseGuardianConfigText - Parses Guardian config JSONC into typed overrides.
//   renderGuardianConfig - Renders managed Guardian config JSONC.
//   ensurePackageInstalled - Writes the pinned vvoc plugin specifier into OpenCode config.
//   writeProviderBaseUrl - Writes a provider options.baseURL override into OpenCode config.
//   syncManagedSubagentRegistrations - Syncs the canonical vvoc-managed subagent registrations into OpenCode config.
//   installManagedAgentPrompts - Creates managed vvoc prompt files for the bundled Guardian/subagent agents when missing.
//   syncManagedAgentPrompts - Rewrites managed vvoc prompt files for the bundled Guardian/subagent agents.
//   readOpenCodeAgentModel - Reads a model override for any OpenCode agent from config.
//   writeOpenCodeAgentModel - Writes or removes a model override for any OpenCode agent in config.
//   readManagedSubagentModels - Reads model overrides for the bundled vvoc subagents from OpenCode config.
//   writeManagedSubagentModel - Writes or removes a bundled vvoc subagent model override in OpenCode config.
//   installGuardianConfig - Creates or preserves managed Guardian config.
//   syncGuardianConfig - Rewrites managed Guardian config while preserving current values.
//   writeGuardianConfig - Writes explicit Guardian overrides to managed config.
//   installMemoryConfig - Creates or preserves managed Memory config.
//   syncMemoryConfig - Rewrites managed Memory config while preserving current values.
//   inspectInstallation - Reads current OpenCode/vvoc installation state for status and doctor commands.
//   describeWriteResult - Formats config write outcomes for CLI output.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.9 - Added generic OpenCode agent model override helpers so built-in subagents like explore can be configured from vvoc.]
// END_CHANGE_SUMMARY

import { applyEdits, format, modify, parse, type ParseError } from "jsonc-parser";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  MANAGED_AGENT_PROMPT_NAMES,
  type ManagedAgentPromptName,
  MANAGED_SUBAGENTS,
  type ManagedSubagentName,
  getManagedAgentPromptPath,
  getManagedSubagentDefinition,
  loadManagedAgentPromptTemplate,
} from "./managed-agents.js";
import {
  parseMemoryConfigText,
  renderMemoryConfig,
  type MemoryConfigOverrides,
} from "../plugins/memory-store.js";
import { getPinnedPackageSpecifier, PACKAGE_NAME } from "./package.js";
import {
  getConfigHome,
  getGlobalOpencodeDir,
  getGlobalVvocDir,
  getProjectVvocDir,
  getVvocAgentsDir,
} from "./vvoc-paths.js";

export const CLI_NAME = "vvoc";
export { PACKAGE_NAME };
export const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";
const MANAGED_MARKER = "Managed by vvoc";
const DEFAULT_GUARDIAN_TIMEOUT_MS = 90_000;
const DEFAULT_GUARDIAN_APPROVAL_RISK_THRESHOLD = 80;
const GUARDIAN_CONFIG_FILE_NAMES = ["guardian.jsonc", "guardian.json"] as const;
const MEMORY_CONFIG_FILE_NAMES = ["memory.jsonc", "memory.json"] as const;
const OPENCODE_CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;
const SECRETS_REDACTION_CONFIG_FILE_NAMES = [
  "secrets-redaction.config.json",
  "secrets-redaction.config.jsonc",
] as const;

const JSON_FORMAT = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const;

type JsonObject = Record<string, unknown>;

export type Scope = "global" | "project";

export type ResolvedPaths = {
  scope: Scope;
  cwd: string;
  configHome: string;
  opencodeBaseDir: string;
  vvocBaseDir: string;
  managedAgentsDirPath: string;
  opencodeConfigPath: string;
  opencodeAlternatePaths: string[];
  guardianConfigPath: string;
  guardianAlternatePaths: string[];
  memoryConfigPath: string;
  memoryConfigAlternates: string[];
  secretsRedactionConfigPath: string;
  secretsRedactionConfigAlternates: string[];
};

export type GuardianConfigOverrides = {
  model?: string;
  variant?: string;
  timeoutMs?: number;
  approvalRiskThreshold?: number;
  reviewToastDurationMs?: number;
};

export type WriteResult = {
  action: "created" | "updated" | "kept" | "skipped";
  path: string;
  reason?: string;
};

export type ManagedSubagentModelMap = Record<ManagedSubagentName, string | undefined>;

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
  guardian: {
    path: string;
    exists: boolean;
    alternates: string[];
    managed: boolean;
    parseError?: string;
    overrides?: GuardianConfigOverrides;
  };
  memory: {
    path: string;
    exists: boolean;
    alternates: string[];
    managed: boolean;
    parseError?: string;
    overrides?: MemoryConfigOverrides;
  };
  secretsRedaction: {
    path: string;
    exists: boolean;
    alternates: string[];
    managed: boolean;
    parseError?: string;
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
  const opencodeBaseDir =
    options.scope === "global" ? getGlobalOpencodeDir(options.configDir) : options.cwd;
  const vvocBaseDir =
    options.scope === "global"
      ? getGlobalVvocDir(options.configDir)
      : getProjectVvocDir(options.cwd);
  const managedAgentsDirPath = getVvocAgentsDir(vvocBaseDir);
  const opencodeSelection = await selectPrimaryPath(
    OPENCODE_CONFIG_FILE_NAMES.map((name) => join(opencodeBaseDir, name)),
  );
  const guardianSelection = await selectPrimaryPath(
    GUARDIAN_CONFIG_FILE_NAMES.map((name) => join(vvocBaseDir, name)),
  );
  const memorySelection = await selectPrimaryPath(
    MEMORY_CONFIG_FILE_NAMES.map((name) => join(vvocBaseDir, name)),
  );
  const secretsRedactionSelection = await selectPrimaryPath(
    SECRETS_REDACTION_CONFIG_FILE_NAMES.map((name) => join(vvocBaseDir, name)),
  );

  return {
    scope: options.scope,
    cwd: options.cwd,
    configHome,
    opencodeBaseDir,
    vvocBaseDir,
    managedAgentsDirPath,
    opencodeConfigPath: opencodeSelection.primary,
    opencodeAlternatePaths: opencodeSelection.alternates,
    guardianConfigPath: guardianSelection.primary,
    guardianAlternatePaths: guardianSelection.alternates,
    memoryConfigPath: memorySelection.primary,
    memoryConfigAlternates: memorySelection.alternates,
    secretsRedactionConfigPath: secretsRedactionSelection.primary,
    secretsRedactionConfigAlternates: secretsRedactionSelection.alternates,
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

// START_BLOCK_ENSURE_MANAGED_SUBAGENT_CONFIG
export function ensureManagedSubagentsConfigText(
  text: string | undefined,
  paths: Pick<ResolvedPaths, "managedAgentsDirPath" | "opencodeConfigPath">,
): string {
  if (!text?.trim()) {
    return renderJson({
      $schema: OPENCODE_SCHEMA_URL,
      agent: Object.fromEntries(
        MANAGED_SUBAGENTS.map((definition) => [
          definition.name,
          getManagedSubagentRegistration(paths, definition.name),
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

  for (const definition of MANAGED_SUBAGENTS) {
    const currentEntry = currentAgents[definition.name];
    const nextEntry = {
      ...getManagedSubagentRegistration(paths, definition.name),
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

export async function syncManagedSubagentRegistrations(paths: ResolvedPaths): Promise<{
  path: string;
  changed: boolean;
}> {
  const currentText = await readOptionalText(paths.opencodeConfigPath);
  const nextText = ensureManagedSubagentsConfigText(currentText, paths);

  if (currentText === nextText) {
    return { path: paths.opencodeConfigPath, changed: false };
  }

  await writeText(paths.opencodeConfigPath, nextText);
  return { path: paths.opencodeConfigPath, changed: true };
}

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

export async function readManagedSubagentModels(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
): Promise<ManagedSubagentModelMap> {
  const models = Object.fromEntries(
    MANAGED_SUBAGENTS.map((definition) => [definition.name, undefined]),
  ) as ManagedSubagentModelMap;
  const currentText = await readOptionalText(paths.opencodeConfigPath);

  if (!currentText) {
    return models;
  }

  const document = parseObjectDocument(currentText, paths.opencodeConfigPath);
  const agentMap = readAgentMap(document, paths.opencodeConfigPath);

  for (const definition of MANAGED_SUBAGENTS) {
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

export async function writeManagedSubagentModel(
  paths: Pick<ResolvedPaths, "managedAgentsDirPath" | "opencodeConfigPath">,
  agentName: ManagedSubagentName,
  options: { model?: string; ensureEntry: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.opencodeConfigPath);
  if (!currentText && !options.ensureEntry) {
    return { action: "kept", path: paths.opencodeConfigPath };
  }

  const baseText = options.ensureEntry
    ? ensureManagedSubagentsConfigText(currentText, paths)
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
    ...getManagedSubagentRegistration(paths, agentName),
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

export function parseGuardianConfigText(text: string, label: string): GuardianConfigOverrides {
  return normalizeGuardianOverrides(parseObjectDocument(text, label), label);
}

// START_BLOCK_RENDER_GUARDIAN_CONFIG
export function renderGuardianConfig(overrides: GuardianConfigOverrides = {}): string {
  const timeoutMs = overrides.timeoutMs ?? DEFAULT_GUARDIAN_TIMEOUT_MS;
  const approvalRiskThreshold =
    overrides.approvalRiskThreshold ?? DEFAULT_GUARDIAN_APPROVAL_RISK_THRESHOLD;
  const reviewToastDurationMs = overrides.reviewToastDurationMs ?? timeoutMs;
  const lines = [
    "// Managed by vvoc.",
    "// `vvoc sync` rewrites files with this marker while preserving current values.",
    "// Remove this header if you want to manage the file manually.",
    "",
    "{",
  ];

  if (overrides.model) {
    lines.push(`  "model": ${JSON.stringify(overrides.model)},`);
  } else {
    lines.push('  // "model": "anthropic/claude-sonnet-4-5",');
  }

  lines.push("");

  if (overrides.variant) {
    lines.push(`  "variant": ${JSON.stringify(overrides.variant)},`);
  } else {
    lines.push('  // "variant": "high",');
  }

  lines.push("");
  lines.push(`  "timeoutMs": ${timeoutMs},`);
  lines.push(`  "approvalRiskThreshold": ${approvalRiskThreshold},`);
  lines.push(`  "reviewToastDurationMs": ${reviewToastDurationMs}`);
  lines.push("}");

  return `${lines.join("\n")}\n`;
}
// END_BLOCK_RENDER_GUARDIAN_CONFIG

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

export async function installGuardianConfig(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.guardianConfigPath);
  if (!currentText) {
    await writeText(paths.guardianConfigPath, renderGuardianConfig());
    return { action: "created", path: paths.guardianConfigPath };
  }

  if (!options.force) {
    if (!isManagedFile(currentText)) {
      return {
        action: "skipped",
        path: paths.guardianConfigPath,
        reason: "existing file is not managed by vvoc",
      };
    }
    return { action: "kept", path: paths.guardianConfigPath };
  }

  return syncGuardianConfig(paths, options);
}

export async function syncGuardianConfig(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.guardianConfigPath);
  if (!currentText) {
    await writeText(paths.guardianConfigPath, renderGuardianConfig());
    return { action: "created", path: paths.guardianConfigPath };
  }

  if (!options.force && !isManagedFile(currentText)) {
    return {
      action: "skipped",
      path: paths.guardianConfigPath,
      reason: "existing file is not managed by vvoc",
    };
  }

  const nextText = renderGuardianConfig(
    parseGuardianConfigText(currentText, paths.guardianConfigPath),
  );
  if (currentText === nextText) {
    return { action: "kept", path: paths.guardianConfigPath };
  }

  await writeText(paths.guardianConfigPath, nextText);
  return { action: "updated", path: paths.guardianConfigPath };
}

export async function writeGuardianConfig(
  paths: ResolvedPaths,
  overrides: GuardianConfigOverrides,
  options: { force: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.guardianConfigPath);
  if (currentText && !options.force && !isManagedFile(currentText)) {
    return {
      action: "skipped",
      path: paths.guardianConfigPath,
      reason: "existing file is not managed by vvoc",
    };
  }

  const nextText = renderGuardianConfig(overrides);
  if (currentText === nextText) {
    return { action: "kept", path: paths.guardianConfigPath };
  }

  await writeText(paths.guardianConfigPath, nextText);
  return {
    action: currentText ? "updated" : "created",
    path: paths.guardianConfigPath,
  };
}
// END_BLOCK_INSTALL_PACKAGE_AND_GUARDIAN_CONFIG

// START_BLOCK_INSTALL_MEMORY_CONFIG
export async function installMemoryConfig(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.memoryConfigPath);
  if (!currentText) {
    await writeText(paths.memoryConfigPath, renderMemoryConfig());
    return { action: "created", path: paths.memoryConfigPath };
  }

  if (!options.force) {
    if (!isManagedFile(currentText)) {
      return {
        action: "skipped",
        path: paths.memoryConfigPath,
        reason: "existing file is not managed by vvoc",
      };
    }
    return { action: "kept", path: paths.memoryConfigPath };
  }

  return syncMemoryConfig(paths, options);
}

export async function syncMemoryConfig(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.memoryConfigPath);
  if (!currentText) {
    await writeText(paths.memoryConfigPath, renderMemoryConfig());
    return { action: "created", path: paths.memoryConfigPath };
  }

  if (!options.force && !isManagedFile(currentText)) {
    return {
      action: "skipped",
      path: paths.memoryConfigPath,
      reason: "existing file is not managed by vvoc",
    };
  }

  const nextText = renderMemoryConfig(parseMemoryConfigText(currentText, paths.memoryConfigPath));
  if (currentText === nextText) {
    return { action: "kept", path: paths.memoryConfigPath };
  }

  await writeText(paths.memoryConfigPath, nextText);
  return { action: "updated", path: paths.memoryConfigPath };
}
// END_BLOCK_INSTALL_MEMORY_CONFIG

// START_BLOCK_INSTALL_SECRETS_REDACTION_CONFIG
export function renderSecretsRedactionConfig(): string {
  const lines = [
    "// Managed by vvoc.",
    "// `vvoc sync` rewrites files with this marker while preserving current values.",
    "// Remove this header if you want to manage the file manually.",
    "",
    "{",
    '  "enabled": true,',
    '  "secret": "${VVOC_SECRET}",',
    '  "ttlMs": 3600000,',
    '  "maxMappings": 10000,',
    '  "patterns": {',
    '    "keywords": [],',
    '    "regex": [],',
    '    "builtin": ["email", "uuid", "ipv4", "mac", "openai_key", "anthropic_key", "github_token", "aws_access_key", "stripe_key", "bearer_token", "bearer_dot", "syn_key", "hex_token"],',
    '    "exclude": []',
    "  },",
    '  "debug": false',
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

export function parseSecretsRedactionConfigText(
  text: string,
  _filePath: string,
): Record<string, unknown> {
  const errors: ParseError[] = [];
  const result = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`parse error at offset ${errors[0].offset}`);
  }
  if (typeof result !== "object" || result === null) {
    throw new Error("root must be an object");
  }
  return result as Record<string, unknown>;
}

export async function installSecretsRedactionConfig(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.secretsRedactionConfigPath);
  if (!currentText) {
    await writeText(paths.secretsRedactionConfigPath, renderSecretsRedactionConfig());
    return { action: "created", path: paths.secretsRedactionConfigPath };
  }

  if (!options.force) {
    if (!isManagedFile(currentText)) {
      return {
        action: "skipped",
        path: paths.secretsRedactionConfigPath,
        reason: "existing file is not managed by vvoc",
      };
    }
    return { action: "kept", path: paths.secretsRedactionConfigPath };
  }

  return syncSecretsRedactionConfig(paths, options);
}

export async function syncSecretsRedactionConfig(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult> {
  const currentText = await readOptionalText(paths.secretsRedactionConfigPath);
  if (!currentText) {
    await writeText(paths.secretsRedactionConfigPath, renderSecretsRedactionConfig());
    return { action: "created", path: paths.secretsRedactionConfigPath };
  }

  if (!options.force && !isManagedFile(currentText)) {
    return {
      action: "skipped",
      path: paths.secretsRedactionConfigPath,
      reason: "existing file is not managed by vvoc",
    };
  }

  const nextText = renderSecretsRedactionConfig();
  if (currentText === nextText) {
    return { action: "kept", path: paths.secretsRedactionConfigPath };
  }

  await writeText(paths.secretsRedactionConfigPath, nextText);
  return { action: "updated", path: paths.secretsRedactionConfigPath };
}
// END_BLOCK_INSTALL_SECRETS_REDACTION_CONFIG

// START_BLOCK_INSPECT_INSTALLATION_STATE
export async function inspectInstallation(paths: ResolvedPaths): Promise<InstallationInspection> {
  const warnings: string[] = [];
  const problems: string[] = [];

  if (paths.opencodeAlternatePaths.length > 0) {
    warnings.push(
      `multiple OpenCode config files exist: ${[paths.opencodeConfigPath, ...paths.opencodeAlternatePaths].join(", ")}`,
    );
  }
  if (paths.guardianAlternatePaths.length > 0) {
    warnings.push(
      `multiple Guardian config files exist: ${[paths.guardianConfigPath, ...paths.guardianAlternatePaths].join(", ")}`,
    );
  }
  if (paths.memoryConfigAlternates.length > 0) {
    warnings.push(
      `multiple Memory config files exist: ${[paths.memoryConfigPath, ...paths.memoryConfigAlternates].join(", ")}`,
    );
  }
  if (paths.secretsRedactionConfigAlternates.length > 0) {
    warnings.push(
      `multiple SecretsRedaction config files exist: ${[paths.secretsRedactionConfigPath, ...paths.secretsRedactionConfigAlternates].join(", ")}`,
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

  const guardianText = await readOptionalText(paths.guardianConfigPath);
  let guardianParseError: string | undefined;
  let guardianOverrides: GuardianConfigOverrides | undefined;
  const guardianManaged = guardianText ? isManagedFile(guardianText) : false;

  if (guardianText) {
    try {
      guardianOverrides = parseGuardianConfigText(guardianText, paths.guardianConfigPath);
    } catch (error) {
      guardianParseError = error instanceof Error ? error.message : String(error);
      problems.push(guardianParseError);
    }
  }

  const memoryText = await readOptionalText(paths.memoryConfigPath);
  let memoryParseError: string | undefined;
  let memoryOverrides: MemoryConfigOverrides | undefined;
  const memoryManaged = memoryText ? isManagedFile(memoryText) : false;

  if (memoryText) {
    try {
      memoryOverrides = parseMemoryConfigText(memoryText, paths.memoryConfigPath);
    } catch (error) {
      memoryParseError = error instanceof Error ? error.message : String(error);
      problems.push(memoryParseError);
    }
  }

  const secretsRedactionText = await readOptionalText(paths.secretsRedactionConfigPath);
  let secretsRedactionParseError: string | undefined;
  const secretsRedactionManaged = secretsRedactionText
    ? isManagedFile(secretsRedactionText)
    : false;

  if (secretsRedactionText) {
    try {
      parseSecretsRedactionConfigText(secretsRedactionText, paths.secretsRedactionConfigPath);
    } catch (error) {
      secretsRedactionParseError = error instanceof Error ? error.message : String(error);
      problems.push(secretsRedactionParseError);
    }
  }

  if (!pluginConfigured) {
    problems.push(`${PACKAGE_NAME} is not configured in ${paths.opencodeConfigPath}`);
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
    guardian: {
      path: paths.guardianConfigPath,
      exists: Boolean(guardianText),
      alternates: paths.guardianAlternatePaths,
      managed: guardianManaged,
      parseError: guardianParseError,
      overrides: guardianOverrides,
    },
    memory: {
      path: paths.memoryConfigPath,
      exists: Boolean(memoryText),
      alternates: paths.memoryConfigAlternates,
      managed: memoryManaged,
      parseError: memoryParseError,
      overrides: memoryOverrides,
    },
    secretsRedaction: {
      path: paths.secretsRedactionConfigPath,
      exists: Boolean(secretsRedactionText),
      alternates: paths.secretsRedactionConfigAlternates,
      managed: secretsRedactionManaged,
      parseError: secretsRedactionParseError,
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

// START_BLOCK_MANAGED_SUBAGENT_HELPERS
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
  if (!text?.trim()) {
    return renderJson({
      $schema: OPENCODE_SCHEMA_URL,
      agent: {},
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

  if (!Object.hasOwn(document, "agent")) {
    nextText = applyEdits(
      nextText,
      modify(nextText, ["agent"], currentAgents, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
}

function getManagedSubagentPromptReference(
  paths: Pick<ResolvedPaths, "managedAgentsDirPath" | "opencodeConfigPath">,
  agentName: ManagedSubagentName,
): string {
  const promptPath = getManagedPromptPath(paths, agentName);
  const promptRef = relative(dirname(paths.opencodeConfigPath), promptPath).replaceAll("\\", "/");
  return `{file:${promptRef.startsWith(".") ? promptRef : `./${promptRef}`}}`;
}

function getManagedSubagentRegistration(
  paths: Pick<ResolvedPaths, "managedAgentsDirPath" | "opencodeConfigPath">,
  agentName: ManagedSubagentName,
): JsonObject {
  const definition = getManagedSubagentDefinition(agentName);
  const registration: JsonObject = {
    description: definition.description,
    mode: "subagent",
    prompt: getManagedSubagentPromptReference(paths, agentName),
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
// END_BLOCK_MANAGED_SUBAGENT_HELPERS

function normalizeGuardianOverrides(raw: unknown, label: string): GuardianConfigOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label}: expected a top-level object`);
  }

  const record = raw as Record<string, unknown>;
  const overrides: GuardianConfigOverrides = {};

  if (Object.hasOwn(record, "model")) {
    overrides.model = readNonEmptyString(record.model, `${label}: model`);
  }
  if (Object.hasOwn(record, "variant")) {
    overrides.variant = readNonEmptyString(record.variant, `${label}: variant`);
  }
  if (Object.hasOwn(record, "timeoutMs")) {
    overrides.timeoutMs = readPositiveInteger(record.timeoutMs, `${label}: timeoutMs`);
  }
  if (Object.hasOwn(record, "approvalRiskThreshold")) {
    overrides.approvalRiskThreshold = readThreshold(
      record.approvalRiskThreshold,
      `${label}: approvalRiskThreshold`,
    );
  }
  if (Object.hasOwn(record, "reviewToastDurationMs")) {
    overrides.reviewToastDurationMs = readPositiveInteger(
      record.reviewToastDurationMs,
      `${label}: reviewToastDurationMs`,
    );
  }

  return overrides;
}

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

function readPositiveInteger(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  throw new Error(`${label}: expected a positive integer`);
}

function readThreshold(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }
  throw new Error(`${label}: expected a number between 0 and 100`);
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
