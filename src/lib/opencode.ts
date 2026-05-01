// FILE: src/lib/opencode.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Manage OpenCode config mutation, provider patching, and the canonical vvoc.json config file.
//   SCOPE: Scope-aware path resolution, pinned plugin writes, top-level OpenCode model/default writes, managed OpenCode default-agent, command, and tool gating, provider baseURL patching, provider object patching, managed OpenCode agent registration/model overrides, managed agent prompt sync, version-aware canonical vvoc config rendering and sync, and installation inspection.
//   INPUTS: Scope-aware filesystem paths, current OpenCode/vvoc config text, and validated config override values.
//   OUTPUTS: Normalized OpenCode/vvoc config text, persisted config writes, and installation inspection snapshots.
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
//   writeOpenCodeProviderObject - Writes or merges a provider.<id> object override.
//   ensureProviderBaseUrlConfigText - Ensures OpenCode config contains the requested provider options.baseURL override.
//   ensureManagedAgentRegistrationsConfigText - Ensures OpenCode config contains the vvoc-managed default agent, command registrations, agent registrations, and tool gating.
//   readVvocConfig - Loads the canonical vvoc.json document when present.
//   ensurePackageInstalled - Writes the pinned vvoc plugin specifier into OpenCode config.
//   installVvocConfig - Creates or refreshes the canonical vvoc.json document.
//   syncVvocConfig - Rewrites the canonical vvoc.json document while preserving valid current values.
//   writeProviderBaseUrl - Writes a provider options.baseURL override into OpenCode config.
//   syncManagedAgentRegistrations - Syncs the canonical vvoc-managed OpenCode agent registrations and tool gating into OpenCode config.
//   installManagedAgentPrompts - Creates managed vvoc prompt files for the bundled Guardian and managed OpenCode agents when missing.
//   syncManagedAgentPrompts - Rewrites managed vvoc prompt files for the bundled Guardian and managed OpenCode agents.
//   ensureManagedPlanDirectory - Creates the managed vvoc planning artifact directory when missing.
//   readOpenCodeAgentModel - Reads a model override for any OpenCode agent from config.
//   readOpenCodeAgentOverride - Reads a model override for any OpenCode agent from config.
//   writeOpenCodeAgentModel - Writes or removes a model override for any OpenCode agent in config.
//   readManagedAgentModels - Reads model overrides for the bundled vvoc-managed OpenCode agents from OpenCode config.
//   readManagedAgentOverrides - Reads model overrides for the bundled vvoc-managed OpenCode agents.
//   writeManagedAgentModel - Writes or removes a bundled vvoc-managed OpenCode agent model override in OpenCode config.
//   writeGuardianConfig - Writes the guardian section into the canonical vvoc.json document.
//   inspectInstallation - Reads current OpenCode/vvoc installation state for status and doctor commands.
//   describeWriteResult - Formats config write outcomes for CLI output.
//   ManagedAgentModelMap - Map of managed agent names to model selections.
//   OpenCodeAgentOverride - Agent override config for OpenCode.
//   ManagedAgentOverrideMap - Map of agent override configs.
//   parseGuardianConfigText - Parse guardian section JSON.
//   renderGuardianConfig - Render guardian section JSON.
//   GuardianConfigOverrides - Guardian config override type.
// END_MODULE_MAP
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.1 - Added managed plan directory resolution and creation for analyst/architect artifacts.]
//   LAST_CHANGE: [v1.0.0 - Added vv-controller as the managed default agent plus vv-plan/vv-review command registrations.]
//   LAST_CHANGE: [v0.9.7 - Removed variant splitting from agent model read/write helpers so provider/model:free passes through unchanged.]
//   LAST_CHANGE: [v0.9.6 - Added managed OpenCode `tools.apply_patch = false` writes during install/init/sync so sessions stay on the hashline-backed `edit` override.]
//   LAST_CHANGE: [v0.9.5 - Moved legacy tracked-agent deletion gating into sync with prompt-file ownership checks so user-owned legacy prompt files prevent cleanup.]
//   LAST_CHANGE: [v0.9.4 - Tightened legacy tracked-agent cleanup to remove only entries that fully match legacy vvoc-managed registration shape, preserving customized user-owned old-name agents.]
//   LAST_CHANGE: [v0.9.3 - Restricted legacy tracked-agent cleanup to entries that match legacy vvoc-managed prompt references so user-owned custom agents with old names are preserved.]
//   LAST_CHANGE: [v0.9.2 - Added conservative cleanup of legacy tracked managed agent registrations so sync removes pre-rename implementer/spec-reviewer/code-reviewer entries.]
//   LAST_CHANGE: [v0.9.1 - Narrowed built-in OpenCode auto-seeding to `agent.explore` so install/init/sync stop rewriting other built-in agent model refs.]
//   LAST_CHANGE: [v0.9.0 - Added OpenCode agent variant read/write helpers so vvoc can translate provider/model:variant into native agent config fields.]
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
  BUILTIN_ROLE_NAMES,
  getBuiltInRoleBindings,
  ROLE_REFERENCE_PREFIX,
} from "./model-roles.js";
import {
  createDefaultVvocConfig,
  createGuardianConfig,
  parseVersionedVvocConfigText,
  parseVvocConfigText,
  renderVvocConfig,
  type GuardianConfig,
  type GuardianConfigOverrides,
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
  getVvocPlansDir,
} from "./vvoc-paths.js";

export const CLI_NAME = "vvoc";
export { PACKAGE_NAME };
export const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";
const MANAGED_MARKER = "Managed by vvoc";
const LEGACY_TRACKED_MANAGED_AGENT_NAMES = [
  "implementer",
  "spec-reviewer",
  "code-reviewer",
] as const;
const LEGACY_TRACKED_ROLE_BINDINGS = {
  implementer: "default",
  "spec-reviewer": "smart",
  "code-reviewer": "smart",
} as const;
const LEGACY_TRACKED_PROMPT_FILE_NAMES = {
  implementer: "implementer.md",
  "spec-reviewer": "spec-reviewer.md",
  "code-reviewer": "code-reviewer.md",
} as const;
const LEGACY_TRACKED_DESCRIPTIONS = {
  implementer: "Implements approved changes with focused verification and a minimal diff.",
  "spec-reviewer":
    "Checks an implementation against the requested spec and flags missing or extra behavior.",
  "code-reviewer":
    "Reviews changes for bugs, regressions, maintainability risks, and missing tests.",
} as const;
const OPENCODE_CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;
const MANAGED_DEFAULT_AGENT = "vv-controller";
const MANAGED_OPENCODE_COMMANDS = {
  "vv-plan": {
    description: "Plan a vvoc workflow without implementing changes.",
    agent: MANAGED_DEFAULT_AGENT,
    template:
      "Route this request as a planning-only vvoc workflow. Use analyst/architect context when helpful, write any durable planning artifact under .vvoc/plans, and stop before implementation.\n\n$ARGUMENTS",
  },
  "vv-review": {
    description: "Run a vvoc review-only workflow over the requested scope.",
    agent: MANAGED_DEFAULT_AGENT,
    template:
      "Route this request as a review_only vvoc workflow. Decide whether spec review, code review, or both are needed, and report findings first.\n\n$ARGUMENTS",
  },
} satisfies Record<string, JsonObject>;

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
  managedPlansDirPath: string;
  opencodeConfigPath: string;
  opencodeAlternatePaths: string[];
};

export type WriteResult = {
  action: "created" | "updated" | "kept" | "skipped";
  path: string;
  reason?: string;
};

export type ManagedAgentModelMap = Record<ManagedOpenCodeAgentName, string | undefined>;
export type OpenCodeAgentOverride = { model?: string };
export type ManagedAgentOverrideMap = Record<ManagedOpenCodeAgentName, OpenCodeAgentOverride>;

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
  secretsRedaction: {
    config?: SecretsRedactionConfig;
  };
  roles: {
    assignments: Array<{ roleId: string; model: string; builtIn: boolean }>;
    unresolvedReferences: Array<{ fieldPath: string; roleRef: string; roleId: string }>;
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
  const managedPlansDirPath = getVvocPlansDir(managedAgentsBaseDir);
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
    managedPlansDirPath,
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
  const builtInRoleBindings = getBuiltInRoleBindings();
  const rootRoleRefs = {
    model: createRoleReference(builtInRoleBindings.opencodeDefaults.model),
    small_model: createRoleReference(builtInRoleBindings.opencodeDefaults.smallModel),
  };
  const builtInAgentModelRefs = {
    explore: createRoleReference(builtInRoleBindings.opencodeAgents.explore),
  };

  if (!text?.trim()) {
    const managedRegistrations = Object.fromEntries(
      MANAGED_OPENCODE_AGENTS.map((definition) => [
        definition.name,
        getManagedOpenCodeAgentRegistration(paths, definition.name),
      ]),
    );
    return renderJson({
      $schema: OPENCODE_SCHEMA_URL,
      model: rootRoleRefs.model,
      small_model: rootRoleRefs.small_model,
      default_agent: MANAGED_DEFAULT_AGENT,
      tools: {
        apply_patch: false,
      },
      agent: {
        ...Object.fromEntries(
          Object.entries(builtInAgentModelRefs).map(([name, model]) => [name, { model }]),
        ),
        ...managedRegistrations,
      },
      command: MANAGED_OPENCODE_COMMANDS,
    });
  }

  const document = parseObjectDocument(text, "OpenCode config");
  const currentAgents = readAgentMap(document, "OpenCode config");
  const currentCommands = readCommandMap(document, "OpenCode config");
  const currentTools = readOptionalObject(document, "tools", "OpenCode config");
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

  if (document.model !== rootRoleRefs.model) {
    nextText = applyEdits(
      nextText,
      modify(nextText, ["model"], rootRoleRefs.model, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  if (document.small_model !== rootRoleRefs.small_model) {
    nextText = applyEdits(
      nextText,
      modify(nextText, ["small_model"], rootRoleRefs.small_model, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  if (document.default_agent !== MANAGED_DEFAULT_AGENT) {
    nextText = applyEdits(
      nextText,
      modify(nextText, ["default_agent"], MANAGED_DEFAULT_AGENT, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  if (currentTools?.apply_patch !== false) {
    nextText = applyEdits(
      nextText,
      modify(nextText, ["tools", "apply_patch"], false, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  for (const [agentName, modelRef] of Object.entries(builtInAgentModelRefs)) {
    const currentEntry = currentAgents[agentName];
    if (!currentEntry) {
      nextText = applyEdits(
        nextText,
        modify(
          nextText,
          ["agent", agentName],
          { model: modelRef },
          {
            formattingOptions: JSON_FORMAT,
          },
        ),
      );
      continue;
    }

    if (currentEntry.model !== modelRef) {
      nextText = applyEdits(
        nextText,
        modify(nextText, ["agent", agentName, "model"], modelRef, {
          formattingOptions: JSON_FORMAT,
        }),
      );
    }
  }

  for (const definition of MANAGED_OPENCODE_AGENTS) {
    const currentEntry = currentAgents[definition.name];
    const registration = getManagedOpenCodeAgentRegistration(paths, definition.name);
    if (!currentEntry) {
      nextText = applyEdits(
        nextText,
        modify(nextText, ["agent", definition.name], registration, {
          formattingOptions: JSON_FORMAT,
        }),
      );
      continue;
    }

    for (const [field, nextValue] of Object.entries(registration)) {
      if (JSON.stringify(currentEntry[field]) === JSON.stringify(nextValue)) {
        continue;
      }

      nextText = applyEdits(
        nextText,
        modify(nextText, ["agent", definition.name, field], nextValue, {
          formattingOptions: JSON_FORMAT,
        }),
      );
    }
  }

  for (const [commandName, registration] of Object.entries(MANAGED_OPENCODE_COMMANDS)) {
    if (JSON.stringify(currentCommands[commandName]) === JSON.stringify(registration)) {
      continue;
    }

    nextText = applyEdits(
      nextText,
      modify(nextText, ["command", commandName], registration, {
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
  const syncedText = ensureManagedAgentRegistrationsConfigText(currentText, paths);
  const nextText = await cleanupLegacyTrackedManagedEntries(syncedText, paths);

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

export async function ensureManagedPlanDirectory(
  paths: Pick<ResolvedPaths, "managedPlansDirPath">,
): Promise<WriteResult> {
  const createdPath = await mkdir(paths.managedPlansDirPath, { recursive: true });
  return {
    action: createdPath ? "created" : "kept",
    path: paths.managedPlansDirPath,
  };
}

export async function readManagedAgentModels(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
): Promise<ManagedAgentModelMap> {
  const overrides = await readManagedAgentOverrides(paths);
  return Object.fromEntries(
    Object.entries(overrides).map(([name, entry]) => [name, entry.model]),
  ) as ManagedAgentModelMap;
}

export async function readManagedAgentOverrides(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
): Promise<ManagedAgentOverrideMap> {
  const overrides = Object.fromEntries(
    MANAGED_OPENCODE_AGENTS.map((definition) => [definition.name, {}]),
  ) as ManagedAgentOverrideMap;
  const currentText = await readOptionalText(paths.opencodeConfigPath);

  if (!currentText) {
    return overrides;
  }

  const document = parseObjectDocument(currentText, paths.opencodeConfigPath);
  const agentMap = readAgentMap(document, paths.opencodeConfigPath);

  for (const definition of MANAGED_OPENCODE_AGENTS) {
    overrides[definition.name] = readAgentOverride(agentMap[definition.name], definition.name);
  }

  return overrides;
}

export async function readOpenCodeAgentModel(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
  agentName: string,
): Promise<string | undefined> {
  return (await readOpenCodeAgentOverride(paths, agentName)).model;
}

export async function readOpenCodeAgentOverride(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
  agentName: string,
): Promise<OpenCodeAgentOverride> {
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

// START_BLOCK_MANAGED_AGENT_MODEL_IO
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
// END_BLOCK_MANAGED_AGENT_MODEL_IO

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
  let roleAssignments: Array<{ roleId: string; model: string; builtIn: boolean }> = [];

  if (vvocText) {
    try {
      const parsedConfig = parseVersionedVvocConfigText(vvocText, paths.vvocConfigPath);
      vvocConfig = parsedConfig.config;
      vvocSourceSchema = parsedConfig.sourceSchema;
      vvocSourceVersion = parsedConfig.sourceVersion;
      roleAssignments = listRoleAssignments(vvocConfig.roles);
    } catch (error) {
      vvocParseError = error instanceof Error ? error.message : String(error);
      problems.push(vvocParseError);
    }
  }

  const unresolvedRoleReferences =
    opencodeText && !opencodeParseError
      ? collectUnresolvedRoleReferences(
          opencodeText,
          paths.opencodeConfigPath,
          vvocConfig?.roles ?? {},
        )
      : [];

  for (const unresolved of unresolvedRoleReferences) {
    problems.push(
      `unresolved role reference at ${unresolved.fieldPath}: ${unresolved.roleRef} (missing role: ${unresolved.roleId})`,
    );
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
    secretsRedaction: {
      config: vvocConfig?.secretsRedaction,
    },
    roles: {
      assignments: roleAssignments,
      unresolvedReferences: unresolvedRoleReferences,
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

function readCommandMap(document: JsonObject, label: string): Record<string, JsonObject> {
  const raw = document.command;
  if (raw === undefined) {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label}: expected "command" to be an object`);
  }

  const entries: Record<string, JsonObject> = {};
  for (const [name, value] of Object.entries(raw as JsonObject)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label}: expected "command.${name}" to be an object`);
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

function listRoleAssignments(roles: Record<string, string>): Array<{
  roleId: string;
  model: string;
  builtIn: boolean;
}> {
  const listed: Array<{ roleId: string; model: string; builtIn: boolean }> = [];

  for (const roleId of BUILTIN_ROLE_NAMES) {
    if (typeof roles[roleId] === "string") {
      listed.push({ roleId, model: roles[roleId], builtIn: true });
    }
  }

  const customRoleIds = Object.keys(roles)
    .filter((roleId) => !BUILTIN_ROLE_NAMES.includes(roleId as (typeof BUILTIN_ROLE_NAMES)[number]))
    .sort((left, right) => left.localeCompare(right));

  for (const roleId of customRoleIds) {
    listed.push({ roleId, model: roles[roleId], builtIn: false });
  }

  return listed;
}

function collectUnresolvedRoleReferences(
  opencodeText: string,
  label: string,
  roleMap: Record<string, string>,
): Array<{ fieldPath: string; roleRef: string; roleId: string }> {
  const document = parseObjectDocument(opencodeText, label);
  const unresolved: Array<{ fieldPath: string; roleRef: string; roleId: string }> = [];

  const collectFromField = (fieldPath: string, value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed.startsWith(ROLE_REFERENCE_PREFIX)) {
      return;
    }

    const roleId = trimmed.slice(ROLE_REFERENCE_PREFIX.length).trim();
    if (!roleId || !Object.hasOwn(roleMap, roleId)) {
      unresolved.push({ fieldPath, roleRef: trimmed, roleId: roleId || "<missing>" });
    }
  };

  collectFromField("model", document.model);
  collectFromField("small_model", document.small_model);

  for (const parentName of ["agent", "command"] as const) {
    const parent = document[parentName];
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
      continue;
    }

    for (const [entryName, entry] of Object.entries(parent as JsonObject)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      collectFromField(`${parentName}.${entryName}.model`, (entry as JsonObject).model);
    }
  }

  return unresolved;
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

function getLegacyTrackedManagedPromptReferences(
  paths: Pick<ResolvedPaths, "managedAgentsDirPath" | "opencodeConfigPath">,
  agentName: (typeof LEGACY_TRACKED_MANAGED_AGENT_NAMES)[number],
): Set<string> {
  const promptPath = join(paths.managedAgentsDirPath, LEGACY_TRACKED_PROMPT_FILE_NAMES[agentName]);
  const promptRef = relative(dirname(paths.opencodeConfigPath), promptPath).replaceAll("\\", "/");
  const normalized = promptRef.startsWith(".") ? promptRef : `./${promptRef}`;
  const references = new Set<string>([`{file:${normalized}}`]);

  if (normalized.startsWith(".") && !normalized.startsWith("../") && !normalized.startsWith("./")) {
    references.add(`{file:./${normalized}}`);
  }

  return references;
}

function isLegacyTrackedManagedRegistration(
  paths: Pick<ResolvedPaths, "managedAgentsDirPath" | "opencodeConfigPath">,
  agentName: (typeof LEGACY_TRACKED_MANAGED_AGENT_NAMES)[number],
  entry: JsonObject,
): boolean {
  const expectedKeys = new Set<string>(
    agentName === "implementer"
      ? ["description", "mode", "prompt", "model"]
      : ["description", "mode", "prompt", "model", "permission"],
  );

  if (Object.keys(entry).length !== expectedKeys.size) {
    return false;
  }

  for (const key of Object.keys(entry)) {
    if (!expectedKeys.has(key)) {
      return false;
    }
  }

  if (entry.mode !== "subagent") {
    return false;
  }

  if (typeof entry.prompt !== "string") {
    return false;
  }

  const expectedLegacyRefs = getLegacyTrackedManagedPromptReferences(paths, agentName);
  if (!expectedLegacyRefs.has(entry.prompt.trim())) {
    return false;
  }

  if (entry.model !== createRoleReference(LEGACY_TRACKED_ROLE_BINDINGS[agentName])) {
    return false;
  }

  if (entry.description !== LEGACY_TRACKED_DESCRIPTIONS[agentName]) {
    return false;
  }

  if (agentName === "implementer") {
    return entry.permission === undefined;
  }

  return JSON.stringify(entry.permission) === JSON.stringify({ edit: "deny" });
}

async function cleanupLegacyTrackedManagedEntries(
  text: string,
  paths: Pick<ResolvedPaths, "managedAgentsDirPath" | "opencodeConfigPath">,
): Promise<string> {
  const document = parseObjectDocument(text, "OpenCode config");
  const currentAgents = readAgentMap(document, "OpenCode config");
  let nextText = text;

  for (const legacyTrackedName of LEGACY_TRACKED_MANAGED_AGENT_NAMES) {
    const currentEntry = currentAgents[legacyTrackedName];
    if (!currentEntry) {
      continue;
    }

    if (!isLegacyTrackedManagedRegistration(paths, legacyTrackedName, currentEntry)) {
      continue;
    }

    if (!(await canDeleteLegacyTrackedManagedEntry(paths, legacyTrackedName))) {
      continue;
    }

    nextText = applyEdits(
      nextText,
      modify(nextText, ["agent", legacyTrackedName], undefined, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
}

async function canDeleteLegacyTrackedManagedEntry(
  paths: Pick<ResolvedPaths, "managedAgentsDirPath">,
  agentName: (typeof LEGACY_TRACKED_MANAGED_AGENT_NAMES)[number],
): Promise<boolean> {
  const legacyPromptPath = join(
    paths.managedAgentsDirPath,
    LEGACY_TRACKED_PROMPT_FILE_NAMES[agentName],
  );
  const promptText = await readOptionalText(legacyPromptPath);
  if (promptText === undefined) {
    return true;
  }

  return isManagedFile(promptText);
}

function getManagedOpenCodeAgentRegistration(
  paths: Pick<ResolvedPaths, "managedAgentsDirPath" | "opencodeConfigPath">,
  agentName: ManagedOpenCodeAgentName,
): JsonObject {
  const definition = getManagedOpenCodeAgentDefinition(agentName);
  const builtInBindings = getBuiltInRoleBindings();
  const registration: JsonObject = {
    description: definition.description,
    mode: definition.mode,
    prompt: getManagedOpenCodeAgentPromptReference(paths, agentName),
    model: createRoleReference(builtInBindings.managedAgents[agentName]),
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

function readAgentOverride(entry: JsonObject | undefined, label: string): OpenCodeAgentOverride {
  if (!entry) {
    return {};
  }

  return {
    model:
      entry.model === undefined ? undefined : readNonEmptyString(entry.model, `${label}.model`),
  };
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

function createRoleReference(roleId: string): string {
  return `${ROLE_REFERENCE_PREFIX}${roleId}`;
}
// END_BLOCK_MANAGED_AGENT_HELPERS

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}: expected a non-empty string`);
  }
  return value.trim();
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeJsonObjects(current: JsonObject, patch: JsonObject): JsonObject {
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
