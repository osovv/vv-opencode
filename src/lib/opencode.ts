// FILE: src/lib/opencode.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Manage OpenCode runtime/TUI config mutation, host compatibility diagnostics, provider patching, and scoped vvoc.json config files.
//   SCOPE: Layer-aware path resolution, pinned runtime and TUI package writes, OpenCode version inspection, managed OpenCode defaults, local skills path registration, provider patching, managed prompts/skills, strict vvoc rendering, and source-aware installation inspection including orchestration.
//   DEPENDS: [jsonc-parser, node:fs/promises, node:path, src/lib/config-layers.ts, src/lib/managed-agents.ts, src/lib/managed-skills.ts, src/lib/orchestration.ts, src/lib/package.ts, src/lib/vvoc-config.ts, src/lib/vvoc-paths.ts]
//   LINKS: [M-CLI-CONFIG, M-ORCHESTRATION-PROFILES]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CLI_NAME - Canonical vvoc CLI binary name.
//   PACKAGE_NAME - Canonical vvoc npm package name.
//   OPENCODE_SCHEMA_URL - OpenCode config schema URL.
//   OPENCODE_TUI_SCHEMA_URL - OpenCode TUI config schema URL.
//   TUI_PACKAGE_SPECIFIER - Pinned base package specifier registered in tui.json(c) so OpenCode selects its ./tui export.
//   MINIMUM_TUI_OPENCODE_VERSION - Minimum OpenCode host version supported by the managed TUI plugin.
//   OpenCodeDefaultModelKey - Supported top-level OpenCode default model fields.
//   Scope - Supported installation scopes for vvoc config writes.
//   ResolvedPaths - Scope-aware path bundle for OpenCode runtime/TUI and vvoc config locations.
//   WriteResult - Result shape returned by managed config write operations.
//   TuiPluginEntry - Supported TUI plugin string or tuple entry.
//   OpenCodeRuntimeInspection - Installed OpenCode version and TUI compatibility snapshot.
//   InstallationInspection - Current OpenCode runtime/TUI and vvoc installation status snapshot.
//   resolvePaths - Resolves OpenCode runtime/TUI and vvoc config paths for global/project scopes.
//   ensurePackageConfigText - Ensures OpenCode config contains the pinned vvoc plugin specifier.
//   ensureTuiPackageConfigText - Ensures TUI config contains the pinned vvoc base package while preserving tuple options.
//   readOpenCodeDefaultModel - Reads a top-level OpenCode model or small_model override.
//   writeOpenCodeDefaultModel - Writes or removes a top-level OpenCode model or small_model override.
//   writeOpenCodeProviderObject - Writes or merges a provider.<id> object override.
//   ensureProviderBaseUrlConfigText - Ensures OpenCode config contains the requested provider options.baseURL override.
//   ensureManagedAgentRegistrationsConfigText - Ensures OpenCode config contains the vvoc-managed default agent, agent registrations, and tool gating.
//   readVvocConfig - Loads the canonical vvoc.json document when present.
//   ensurePackageInstalled - Writes the pinned vvoc plugin specifier into OpenCode config.
//   ensureTuiPackageInstalled - Writes the pinned vvoc base package into dedicated tui.json(c).
//   installVvocConfig - Creates or refreshes the canonical vvoc.json document.
//   syncVvocConfig - Rewrites the canonical vvoc.json document while preserving valid current values.
//   writeProviderBaseUrl - Writes a provider options.baseURL override into OpenCode config.
//   syncManagedAgentRegistrations - Syncs the canonical vvoc-managed OpenCode agent registrations and tool gating into OpenCode config.
//   installManagedAgentPrompts - Creates managed vvoc prompt files for the bundled Guardian and managed OpenCode agents when missing.
//   syncManagedAgentPrompts - Rewrites managed vvoc prompt files for the bundled Guardian and managed OpenCode agents.
//   installManagedSkillFiles - Creates managed vvoc skill files from bundled templates.
//   syncManagedSkillFiles - Rewrites managed vvoc skill files from bundled templates.
//   ensureManagedSkillSymlink - Creates symlink from OpenCode skills dir to vvoc skills dir for skill discovery.
//   readOpenCodeAgentModel - Reads a model override for any OpenCode agent from config.
//   readOpenCodeAgentOverride - Reads a model override for any OpenCode agent from config.
//   writeOpenCodeAgentModel - Writes or removes a model override for any OpenCode agent in config.
//   readManagedAgentModels - Reads model overrides for the bundled vvoc-managed OpenCode agents from OpenCode config.
//   readManagedAgentOverrides - Reads model overrides for the bundled vvoc-managed OpenCode agents.
//   writeManagedAgentModel - Writes or removes a bundled vvoc-managed OpenCode agent model override in OpenCode config.
//   writeGuardianConfig - Writes the guardian section into the canonical vvoc.json document.
//   inspectOpenCodeRuntime - Reads the installed OpenCode version and evaluates TUI compatibility.
//   isTuiOpenCodeVersionCompatible - Compares an OpenCode version with the managed TUI minimum.
//   inspectInstallation - Reads current OpenCode/vvoc installation state for status and doctor commands.
//   inspectInstallationForScope - Reads installation state using strict/effective layered source resolution.
//   describeWriteResult - Formats config write outcomes for CLI output.
//   ManagedAgentModelMap - Map of managed agent names to model selections.
//   OpenCodeAgentOverride - Agent override config for OpenCode.
//   ManagedAgentOverrideMap - Map of agent override configs.
//   parseGuardianConfigText - Parse guardian section JSON.
//   renderGuardianConfig - Render guardian section JSON.
//   GuardianConfigOverrides - Guardian config override type.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.2 - Registered the pinned base package for TUI loading, migrated legacy subpath entries, and diagnosed incompatible OpenCode hosts.]
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added conservative dedicated TUI config mutation, path resolution, and installation inspection.]
//   LAST_CHANGE: [v1.3.0 - Removed old-name managed-agent and managed-command cleanup from syncManagedAgentRegistrations.]
//   LAST_CHANGE: [v1.2.0 - Switched vvoc config mutation paths to strict current-only parsing for existing vvoc.json files.]
//   LAST_CHANGE: [v1.1.1 - Fixed syncManagedSkillFiles to not sync references when parent skill is skipped (user-owned/custom). Added regression coverage.]
//   LAST_CHANGE: [v1.1.0 - Switched project-scope writes to .opencode/.vvoc layers and added local managed skills path registration.]
//   LAST_CHANGE: [v0.5.1 - Added ensureManagedSkillSymlink. Fixed renderManagedSkill to preserve YAML frontmatter.]
//   LAST_CHANGE: [v1.0.1 - Added managed plan directory resolution and creation for analyst/architect artifacts. Removed in v1.2.0 — superseded by spec package layout under .vvoc/specs/<id>/.]
//   LAST_CHANGE: [v0.5.0 - Replaced managed command registrations (vv-plan/vv-review) with managed skills system. Added managedSkillsDirPath to ResolvedPaths. Added installManagedSkillFiles and syncManagedSkillFiles.]
//   LAST_CHANGE: [v0.9.7 - Removed variant splitting from agent model read/write helpers so provider/model:free passes through unchanged.]
//   LAST_CHANGE: [v0.9.6 - Added managed OpenCode `tools.apply_patch = false` writes during install/init/sync so sessions stay on the hashline-backed `edit` override.]
//   LAST_CHANGE: [v0.9.5 - Moved legacy tracked-agent deletion gating into sync with prompt-file ownership checks so user-owned legacy prompt files prevent cleanup.]
//   LAST_CHANGE: [v0.9.4 - Tightened legacy tracked-agent cleanup to remove only entries that fully match legacy vvoc-managed registration shape, preserving customized user-owned old-name agents.]
//   LAST_CHANGE: [v0.9.3 - Restricted legacy tracked-agent cleanup to entries that match legacy vvoc-managed prompt references so user-owned custom agents with old names are preserved.]
//   LAST_CHANGE: [v0.9.2 - Added conservative cleanup of legacy tracked managed agent registrations so sync removes pre-rename implementer/spec-reviewer/code-reviewer entries.]
//   LAST_CHANGE: [v0.9.1 - Narrowed built-in OpenCode auto-seeding to `agent.explore` so install/init/sync stop rewriting other built-in agent model refs.]
//   LAST_CHANGE: [v0.9.0 - Added OpenCode agent variant read/write helpers so vvoc can translate provider/model:variant into native agent config fields.]
//   LAST_CHANGE: [C-PRESET-ORCHESTRATION-PROFILES - Added resolved orchestration profile inspection for selected and default vvoc sources.]
// END_CHANGE_SUMMARY

import { applyEdits, format, modify, parse, type ParseError } from "jsonc-parser";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
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
  MANAGED_SKILL_NAMES,
  type ManagedSkillName,
  getManagedSkillFilePath,
  listManagedSkillReferenceNames,
  loadManagedSkillReference,
  loadManagedSkillTemplate,
} from "./managed-skills.js";
import {
  BUILTIN_ROLE_NAMES,
  getBuiltInRoleBindings,
  ROLE_REFERENCE_PREFIX,
} from "./model-roles.js";
import { resolveOrchestrationPolicy, type OrchestrationProfile } from "./orchestration.js";
import {
  createDefaultVvocConfig,
  createGuardianConfig,
  parseVvocConfigText,
  parseVersionedVvocConfigText,
  renderVvocConfig,
  type GuardianConfig,
  type GuardianConfigOverrides,
  type SecretsRedactionConfig,
  type VvocConfig,
} from "./vvoc-config.js";
import { getPinnedPackageSpecifier, PACKAGE_NAME, PACKAGE_VERSION } from "./package.js";
import {
  resolveConfigWriteTargets,
  resolveOpenCodeConfigSource,
  resolveOpenCodeTuiConfigSource,
  resolveVvocConfigSource,
  type ConfigReadScope,
  type ConfigSource,
} from "./config-layers.js";
import {
  getConfigHome,
  getGlobalOpencodeSkillsDir,
  getGlobalVvocDir,
  getVvocAgentsDir,
  getVvocSkillsDir,
} from "./vvoc-paths.js";

export const CLI_NAME = "vvoc";
export { PACKAGE_NAME };
export const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";
export const OPENCODE_TUI_SCHEMA_URL = "https://opencode.ai/tui.json";
export const TUI_PACKAGE_SPECIFIER = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;
export const MINIMUM_TUI_OPENCODE_VERSION = "1.18.2";
const MANAGED_MARKER = "Managed by vvoc";
const OPENCODE_CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;
const OPENCODE_TUI_CONFIG_FILE_NAMES = ["tui.json", "tui.jsonc"] as const;
const MANAGED_DEFAULT_AGENT = "vv-controller";

const JSON_FORMAT = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const;

type JsonObject = Record<string, unknown>;
export type TuiPluginEntry = string | [string, JsonObject];
export type OpenCodeDefaultModelKey = "model" | "small_model";

export type Scope = "global" | "project";

export type ResolvedPaths = {
  scope: Scope;
  cwd: string;
  configHome: string;
  projectRoot?: string;
  opencodeBaseDir: string;
  vvocBaseDir: string;
  vvocConfigPath: string;
  managedAgentsDirPath: string;
  managedSkillsDirPath: string;
  opencodeConfigPath: string;
  opencodeAlternatePaths: string[];
  opencodeTuiConfigPath: string;
  opencodeTuiAlternatePaths: string[];
};

export type WriteResult = {
  action: "created" | "updated" | "kept" | "skipped";
  path: string;
  reason?: string;
};

export type ManagedAgentModelMap = Record<ManagedOpenCodeAgentName, string | undefined>;
export type OpenCodeAgentOverride = { model?: string };
export type ManagedAgentOverrideMap = Record<ManagedOpenCodeAgentName, OpenCodeAgentOverride>;

export type OpenCodeRuntimeInspection = {
  version?: string;
  minimumTuiVersion: string;
  tuiCompatible?: boolean;
  error?: string;
};

export type InstallationInspection = {
  scope: ConfigReadScope;
  runtime: OpenCodeRuntimeInspection;
  opencode: {
    path: string;
    exists: boolean;
    alternates: string[];
    parseError?: string;
    pluginConfigured: boolean;
    plugins: string[];
  };
  tui: {
    path: string;
    exists: boolean;
    alternates: string[];
    parseError?: string;
    pluginConfigured: boolean;
    plugins: TuiPluginEntry[];
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
  orchestration: {
    profile?: OrchestrationProfile;
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
  const targets = await resolveConfigWriteTargets(options);
  const configHome = getConfigHome(options.configDir);
  const managedAgentsDirPath = getVvocAgentsDir(targets.vvocBaseDir);
  const managedSkillsDirPath = getVvocSkillsDir(targets.vvocBaseDir);

  return {
    scope: options.scope,
    cwd: options.cwd,
    configHome,
    projectRoot: targets.projectRoot,
    opencodeBaseDir: targets.opencodeBaseDir,
    vvocBaseDir: targets.vvocBaseDir,
    vvocConfigPath: targets.vvocConfigPath,
    managedAgentsDirPath,
    managedSkillsDirPath,
    opencodeConfigPath: targets.opencodeConfigPath,
    opencodeAlternatePaths: await resolveOpenCodeAlternates(
      targets.opencodeBaseDir,
      targets.opencodeConfigPath,
    ),
    opencodeTuiConfigPath: targets.opencodeTuiConfigPath,
    opencodeTuiAlternatePaths: await resolveConfigAlternates(
      targets.opencodeBaseDir,
      targets.opencodeTuiConfigPath,
      OPENCODE_TUI_CONFIG_FILE_NAMES,
    ),
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

// START_BLOCK_ENSURE_MANAGED_AGENT_CONFIG
export function ensureManagedAgentRegistrationsConfigText(
  text: string | undefined,
  paths: Pick<
    ResolvedPaths,
    "managedAgentsDirPath" | "managedSkillsDirPath" | "opencodeConfigPath"
  >,
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
      skills: {
        paths: [getManagedSkillsPathReference(paths)],
      },
      command: {},
    });
  }

  const document = parseObjectDocument(text, "OpenCode config");
  const currentAgents = readAgentMap(document, "OpenCode config");
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

  return ensureManagedSkillsPathConfigText(
    ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT))),
    paths,
  );
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

// START_BLOCK_MANAGED_SKILL_FUNCTIONS
export async function installManagedSkillFiles(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];

  for (const skillName of MANAGED_SKILL_NAMES) {
    const skillPath = getManagedSkillFilePath(paths.managedSkillsDirPath, skillName);
    const currentText = await readOptionalText(skillPath);
    if (!currentText) {
      await writeText(skillPath, await renderManagedSkill(skillName));
      results.push({ action: "created", path: skillPath });
    } else if (!options.force) {
      if (!hasYamlFrontmatter(currentText)) {
        results.push({
          action: "skipped",
          path: skillPath,
          reason: "existing file has no YAML frontmatter — might not be a skill",
        });
      } else {
        results.push({ action: "kept", path: skillPath });
      }
      continue;
    } else {
      results.push(await syncManagedSkill(paths, skillName, options));
    }
    const refResults = await syncManagedSkillReferences(paths.managedSkillsDirPath, skillName);
    results.push(...refResults);
  }

  return results;
}

export async function syncManagedSkillFiles(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];

  for (const skillName of MANAGED_SKILL_NAMES) {
    const skillResult = await syncManagedSkill(paths, skillName, options);
    results.push(skillResult);
    // Only sync references when the parent skill was not skipped (user-owned/custom)
    if (skillResult.action !== "skipped") {
      const refResults = await syncManagedSkillReferences(paths.managedSkillsDirPath, skillName);
      results.push(...refResults);
    }
  }

  return results;
}
// END_BLOCK_MANAGED_SKILL_FUNCTIONS

// START_BLOCK_MANAGED_SKILL_SYMLINK
export async function ensureManagedSkillSymlink(configDir?: string): Promise<WriteResult> {
  const globalSkillsDir = getVvocSkillsDir(getGlobalVvocDir(configDir));
  const opencodeSkillsDir = getGlobalOpencodeSkillsDir(configDir);
  const symlinkPath = join(opencodeSkillsDir, "vvoc");

  // Create the OpenCode skills parent directory
  await mkdir(opencodeSkillsDir, { recursive: true });

  // Track whether this is an update or first creation
  let wasStale = false;
  try {
    await unlink(symlinkPath);
    wasStale = true;
  } catch {
    // Symlink did not exist — will be created fresh
  }

  // Create symlink: opencode/skills/vvoc -> vvoc/skills
  await symlink(globalSkillsDir, symlinkPath);
  return { action: wasStale ? "updated" : "created", path: symlinkPath };
}
// END_BLOCK_MANAGED_SKILL_SYMLINK

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
  paths: Pick<
    ResolvedPaths,
    "managedAgentsDirPath" | "managedSkillsDirPath" | "opencodeConfigPath"
  >,
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

// START_BLOCK_INSPECT_OPENCODE_RUNTIME
export async function inspectOpenCodeRuntime(
  run: () => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> = runOpenCodeVersionCommand,
): Promise<OpenCodeRuntimeInspection> {
  try {
    const result = await run();
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      return {
        minimumTuiVersion: MINIMUM_TUI_OPENCODE_VERSION,
        error: `opencode --version failed: ${detail}`,
      };
    }

    const version = extractOpenCodeVersion(`${result.stdout}\n${result.stderr}`);
    if (!version) {
      return {
        minimumTuiVersion: MINIMUM_TUI_OPENCODE_VERSION,
        error: "opencode --version did not return a semantic version",
      };
    }

    return {
      version,
      minimumTuiVersion: MINIMUM_TUI_OPENCODE_VERSION,
      tuiCompatible: isTuiOpenCodeVersionCompatible(version),
    };
  } catch (error) {
    return {
      minimumTuiVersion: MINIMUM_TUI_OPENCODE_VERSION,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isTuiOpenCodeVersionCompatible(version: string): boolean {
  const current = parseSemanticVersion(version);
  const minimum = parseSemanticVersion(MINIMUM_TUI_OPENCODE_VERSION);
  if (!current || !minimum) return false;

  for (let index = 0; index < 3; index += 1) {
    const currentPart = current.parts[index] ?? 0;
    const minimumPart = minimum.parts[index] ?? 0;
    if (currentPart > minimumPart) return true;
    if (currentPart < minimumPart) return false;
  }

  return !current.prerelease || Boolean(minimum.prerelease);
}

async function runOpenCodeVersionCommand(): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const subprocess = Bun.spawn({
    cmd: ["opencode", "--version"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function extractOpenCodeVersion(output: string): string | undefined {
  const match = output.match(
    /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/,
  );
  return match?.[1];
}

function parseSemanticVersion(
  value: string,
): { parts: [number, number, number]; prerelease?: string } | undefined {
  const match = value
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return undefined;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4],
  };
}
// END_BLOCK_INSPECT_OPENCODE_RUNTIME

// START_BLOCK_INSPECT_INSTALLATION_STATE
export async function inspectInstallation(
  paths: ResolvedPaths,
  options: { runtime?: OpenCodeRuntimeInspection } = {},
): Promise<InstallationInspection> {
  const warnings: string[] = [];
  const problems: string[] = [];
  const runtime = options.runtime ?? {
    minimumTuiVersion: MINIMUM_TUI_OPENCODE_VERSION,
  };

  if (runtime.error) {
    problems.push(`OpenCode version unavailable: ${runtime.error}`);
  } else if (runtime.tuiCompatible === false) {
    problems.push(
      `OpenCode ${runtime.version ?? "unknown"} is incompatible with /context; ${runtime.minimumTuiVersion} or newer is required`,
    );
  }

  if (paths.opencodeAlternatePaths.length > 0) {
    warnings.push(
      `multiple OpenCode config files exist: ${[paths.opencodeConfigPath, ...paths.opencodeAlternatePaths].join(", ")}`,
    );
  }

  if (paths.opencodeTuiAlternatePaths.length > 0) {
    warnings.push(
      `multiple OpenCode TUI config files exist: ${[paths.opencodeTuiConfigPath, ...paths.opencodeTuiAlternatePaths].join(", ")}`,
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

  const tuiText = await readOptionalText(paths.opencodeTuiConfigPath);
  let tuiParseError: string | undefined;
  let tuiPlugins: TuiPluginEntry[] = [];
  let tuiPluginConfigured = false;

  if (tuiText) {
    try {
      const document = parseObjectDocument(tuiText, paths.opencodeTuiConfigPath);
      tuiPlugins = readTuiPluginList(document, paths.opencodeTuiConfigPath);
      tuiPluginConfigured = tuiPlugins.some((entry) =>
        isTuiPackageSpecifier(readTuiPluginName(entry)),
      );
    } catch (error) {
      tuiParseError = error instanceof Error ? error.message : String(error);
      problems.push(tuiParseError);
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
  if (!tuiPluginConfigured) {
    problems.push(`${TUI_PACKAGE_SPECIFIER} is not configured in ${paths.opencodeTuiConfigPath}`);
  }
  if (!vvocText) {
    problems.push(`vvoc config is missing at ${paths.vvocConfigPath}`);
  }

  return {
    scope: paths.scope,
    runtime,
    opencode: {
      path: paths.opencodeConfigPath,
      exists: Boolean(opencodeText),
      alternates: paths.opencodeAlternatePaths,
      parseError: opencodeParseError,
      pluginConfigured,
      plugins,
    },
    tui: {
      path: paths.opencodeTuiConfigPath,
      exists: Boolean(tuiText),
      alternates: paths.opencodeTuiAlternatePaths,
      parseError: tuiParseError,
      pluginConfigured: tuiPluginConfigured,
      plugins: tuiPlugins,
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
    orchestration: {
      profile: vvocConfig ? resolveOrchestrationPolicy(vvocConfig).profile : undefined,
    },
    roles: {
      assignments: roleAssignments,
      unresolvedReferences: unresolvedRoleReferences,
    },
    warnings,
    problems,
  };
}

export async function inspectInstallationForScope(options: {
  scope: ConfigReadScope;
  cwd: string;
  configDir?: string;
  inspectRuntime?: () => Promise<OpenCodeRuntimeInspection>;
}): Promise<
  InstallationInspection & {
    opencodeSource: ConfigSource;
    opencodeTuiSource: ConfigSource;
    vvocSource: ConfigSource;
  }
> {
  const [opencodeSource, opencodeTuiSource, vvocSource, runtime] = await Promise.all([
    resolveOpenCodeConfigSource({
      scope: options.scope,
      cwd: options.cwd,
      configDir: options.configDir,
    }),
    resolveOpenCodeTuiConfigSource({
      scope: options.scope,
      cwd: options.cwd,
      configDir: options.configDir,
    }),
    resolveVvocConfigSource({
      scope: options.scope,
      cwd: options.cwd,
      configDir: options.configDir,
      allowDefault: options.scope === "effective",
    }),
    (options.inspectRuntime ?? inspectOpenCodeRuntime)(),
  ]);

  if (options.scope === "project") {
    const missingSource = [opencodeSource, vvocSource].find((source) => source.kind === "missing");
    if (missingSource) {
      throw new Error(
        missingSource.reason ?? "project config missing; run vvoc install --scope project",
      );
    }
  }

  const fallbackPaths = await resolvePaths({
    scope: options.scope === "global" ? "global" : "project",
    cwd: options.cwd,
    configDir: options.configDir,
  });
  const opencodeConfigPath = opencodeSource.path ?? fallbackPaths.opencodeConfigPath;
  const opencodeTuiConfigPath = opencodeTuiSource.path ?? fallbackPaths.opencodeTuiConfigPath;
  const vvocConfigPath = vvocSource.path ?? fallbackPaths.vvocConfigPath;
  const scopedPaths: ResolvedPaths = {
    ...fallbackPaths,
    opencodeBaseDir: dirname(opencodeConfigPath),
    vvocBaseDir: dirname(vvocConfigPath),
    opencodeConfigPath,
    opencodeTuiConfigPath,
    vvocConfigPath,
    opencodeAlternatePaths: [],
    opencodeTuiAlternatePaths: [],
    managedAgentsDirPath: getVvocAgentsDir(dirname(vvocConfigPath)),
    managedSkillsDirPath: getVvocSkillsDir(dirname(vvocConfigPath)),
  };

  const inspection = await inspectInstallation(scopedPaths, { runtime });
  return {
    ...inspection,
    orchestration: {
      profile:
        inspection.orchestration.profile ??
        (vvocSource.kind === "default"
          ? resolveOrchestrationPolicy(createDefaultVvocConfig()).profile
          : undefined),
    },
    scope: options.scope,
    opencodeSource,
    opencodeTuiSource,
    vvocSource,
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

function readTuiPluginList(document: JsonObject, label: string): TuiPluginEntry[] {
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

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label}: expected an array of strings`);
  }
  return value.slice();
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

function isPackagePluginSpecifier(value: string): boolean {
  return value === PACKAGE_NAME || value.startsWith(`${PACKAGE_NAME}@`);
}

function readTuiPluginName(entry: TuiPluginEntry): string {
  return typeof entry === "string" ? entry : entry[0];
}

function isManagedTuiPackageSpecifier(value: string): boolean {
  return (
    isBasePackageSpecifier(value) ||
    value === `${PACKAGE_NAME}/tui` ||
    (value.startsWith(`${PACKAGE_NAME}@`) && value.endsWith("/tui"))
  );
}

function isTuiPackageSpecifier(value: string): boolean {
  return value === TUI_PACKAGE_SPECIFIER;
}

function isBasePackageSpecifier(value: string): boolean {
  if (value === PACKAGE_NAME) return true;
  const prefix = `${PACKAGE_NAME}@`;
  return value.startsWith(prefix) && !value.slice(prefix.length).includes("/");
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

function getManagedSkillsPathReference(
  paths: Pick<ResolvedPaths, "managedSkillsDirPath" | "opencodeConfigPath">,
): string {
  const skillsRef = relative(
    dirname(paths.opencodeConfigPath),
    paths.managedSkillsDirPath,
  ).replaceAll("\\", "/");
  return skillsRef.startsWith(".") ? skillsRef : `./${skillsRef}`;
}

function ensureManagedSkillsPathConfigText(
  text: string,
  paths: Pick<ResolvedPaths, "managedSkillsDirPath" | "opencodeConfigPath">,
): string {
  const document = parseObjectDocument(text, "OpenCode config");
  const skills = readOptionalObject(document, "skills", "OpenCode config");
  const rawPaths = skills?.paths;
  const currentPaths =
    rawPaths === undefined ? [] : readStringArray(rawPaths, "OpenCode config: skills.paths");
  const managedSkillsPath = getManagedSkillsPathReference(paths);

  if (currentPaths.includes(managedSkillsPath)) {
    return text;
  }

  const nextPaths = [...currentPaths, managedSkillsPath];
  const nextText = applyEdits(
    text,
    modify(text, ["skills", "paths"], nextPaths, {
      formattingOptions: JSON_FORMAT,
    }),
  );

  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
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

async function renderManagedSkill(skillName: ManagedSkillName): Promise<string> {
  return loadManagedSkillTemplate(skillName);
}

async function syncManagedSkillReferences(
  skillsDirPath: string,
  skillName: ManagedSkillName,
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  const referenceNames = await listManagedSkillReferenceNames(skillName);
  for (const refName of referenceNames) {
    const templateContent = await loadManagedSkillReference(skillName, refName);
    const targetPath = join(skillsDirPath, skillName, "references", refName);
    const currentContent = await readOptionalText(targetPath);
    if (currentContent === templateContent) {
      results.push({ action: "kept", path: targetPath });
      continue;
    }
    await writeText(targetPath, templateContent);
    results.push({
      action: currentContent ? "updated" : "created",
      path: targetPath,
    });
  }
  return results;
}

async function syncManagedSkill(
  paths: ResolvedPaths,
  skillName: ManagedSkillName,
  options: { force: boolean },
): Promise<WriteResult> {
  const skillPath = getManagedSkillFilePath(paths.managedSkillsDirPath, skillName);
  const currentText = await readOptionalText(skillPath);

  if (!currentText) {
    await writeText(skillPath, await renderManagedSkill(skillName));
    return { action: "created", path: skillPath };
  }

  if (!options.force && !hasYamlFrontmatter(currentText)) {
    return {
      action: "skipped",
      path: skillPath,
      reason: "existing file has no YAML frontmatter — might not be a skill",
    };
  }

  const nextText = await renderManagedSkill(skillName);
  if (currentText === nextText) {
    return { action: "kept", path: skillPath };
  }

  await writeText(skillPath, nextText);
  return { action: "updated", path: skillPath };
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

function hasYamlFrontmatter(text: string): boolean {
  return text.startsWith("---\n");
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

async function resolveOpenCodeAlternates(
  opencodeBaseDir: string,
  selectedPath: string,
): Promise<string[]> {
  return resolveConfigAlternates(opencodeBaseDir, selectedPath, OPENCODE_CONFIG_FILE_NAMES);
}

async function resolveConfigAlternates(
  baseDir: string,
  selectedPath: string,
  fileNames: readonly string[],
): Promise<string[]> {
  const alternates: string[] = [];

  for (const candidate of fileNames.map((name) => join(baseDir, name))) {
    if (candidate !== selectedPath && (await readOptionalText(candidate)) !== undefined) {
      alternates.push(candidate);
    }
  }

  return alternates;
}
// END_BLOCK_FILESYSTEM_HELPERS
