// FILE: src/lib/opencode/agent-registrations.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Conservative vvoc-managed OpenCode agent registrations, managed prompts and skills materialization, and managed agent model IO.
//   SCOPE: Managed default agent and agent-map config text with role references and tool gating, skills path registration, managed prompt/skill file install and sync with managed-marker and frontmatter guards, the OpenCode skills symlink, and read/write of managed agent model overrides. Generic model/default-model/provider overrides live in model-overrides.ts.
//   DEPENDS: [jsonc-parser, node:fs/promises, node:path, src/lib/managed-agents.ts, src/lib/managed-skills.ts, src/lib/model-roles.ts, src/lib/opencode/shared-utils.ts, src/lib/opencode/paths.ts]
//   LINKS: [M-CLI-CONFIG, M-CLI-MANAGED-AGENTS, M-CLI-MANAGED-SKILLS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ManagedAgentModelMap - Map of managed agent names to model selections.
//   ManagedAgentOverrideMap - Map of agent override configs.
//   ensureManagedAgentRegistrationsConfigText - Ensures OpenCode config contains the vvoc-managed default agent, agent registrations, and tool gating.
//   syncManagedAgentRegistrations - Syncs the canonical vvoc-managed OpenCode agent registrations and tool gating into OpenCode config.
//   installManagedAgentPrompts - Creates managed vvoc prompt files for the bundled Guardian and managed OpenCode agents when missing.
//   syncManagedAgentPrompts - Rewrites managed vvoc prompt files for the bundled Guardian and managed OpenCode agents.
//   installManagedSkillFiles - Creates managed vvoc skill files from bundled templates.
//   syncManagedSkillFiles - Rewrites managed vvoc skill files from bundled templates.
//   ensureManagedSkillSymlink - Creates symlink from OpenCode skills dir to vvoc skills dir for skill discovery.
//   readManagedAgentModels - Reads model overrides for the bundled vvoc-managed OpenCode agents from OpenCode config.
//   readManagedAgentOverrides - Reads model overrides for the bundled vvoc-managed OpenCode agents.
//   writeManagedAgentModel - Writes or removes a bundled vvoc-managed OpenCode agent model override in OpenCode config.
//   readAgentMap - Reads the agent object map from a parsed OpenCode config.
//   ensureAgentConfigText - Ensures an OpenCode config document with an agent object exists.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-MODULE-SPLIT - Extracted managed agent registrations, prompts, skills, symlink, and managed model IO from the former src/lib/opencode.ts monolith into this zone module.]
// END_CHANGE_SUMMARY

import { applyEdits, format, modify } from "jsonc-parser";
import { lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  MANAGED_AGENT_PROMPT_NAMES,
  MANAGED_OPENCODE_AGENTS,
  type ManagedAgentPromptName,
  getManagedAgentPromptPath,
  getManagedOpenCodeAgentDefinition,
  loadManagedAgentPromptTemplate,
  type ManagedOpenCodeAgentName,
} from "../managed-agents.js";
import {
  MANAGED_SKILL_NAMES,
  type ManagedSkillName,
  getManagedSkillFilePath,
  listManagedSkillReferenceNames,
  loadManagedSkillReference,
  loadManagedSkillTemplate,
} from "../managed-skills.js";
import { getBuiltInRoleBindings, ROLE_REFERENCE_PREFIX } from "../model-roles.js";
import {
  ensureOpenCodeConfigText,
  ensureTrailingNewline,
  hasYamlFrontmatter,
  isManagedFile,
  OPENCODE_SCHEMA_URL,
  parseObjectDocument,
  readAgentOverride,
  readOptionalObject,
  readOptionalText,
  readStringArray,
  renderJson,
  stripMarkdownFrontmatter,
  updateAgentEntryText,
  writeText,
  type JsonObject,
  type WriteResult,
} from "./shared-utils.js";
import { getGlobalOpencodeSkillsDir, getGlobalVvocDir, getVvocSkillsDir } from "../vvoc-paths.js";
import type { ResolvedPaths } from "./paths.js";

const MANAGED_DEFAULT_AGENT = "vv-controller";

const JSON_FORMAT = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const;

export type ManagedAgentModelMap = Record<ManagedOpenCodeAgentName, string | undefined>;
export type ManagedAgentOverrideMap = Record<ManagedOpenCodeAgentName, { model?: string }>;
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

  // Never destroy a non-symlink at this path: a regular file or directory here
  // is user-owned content, not a vvoc-managed link, and must not be clobbered.
  let wasStale = false;
  try {
    const stats = await lstat(symlinkPath);
    if (!stats.isSymbolicLink()) {
      return { action: "skipped", path: symlinkPath };
    }
    if (resolve(await readlink(symlinkPath)) === resolve(globalSkillsDir)) {
      // Already the current vvoc-managed link — nothing to do.
      return { action: "kept", path: symlinkPath };
    }
    // A stale or foreign symlink: replace it with the current vvoc link.
    await unlink(symlinkPath);
    wasStale = true;
  } catch {
    // Path does not exist — will be created fresh.
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

// START_BLOCK_MANAGED_AGENT_HELPERS
export function readAgentMap(document: JsonObject, label: string): Record<string, JsonObject> {
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

export function ensureAgentConfigText(text: string | undefined): string {
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

function getManagedPromptPath(
  paths: Pick<ResolvedPaths, "managedAgentsDirPath">,
  agentName: ManagedAgentPromptName,
): string {
  return getManagedAgentPromptPath(paths.managedAgentsDirPath, agentName);
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

function createRoleReference(roleId: string): string {
  return `${ROLE_REFERENCE_PREFIX}${roleId}`;
}
// END_BLOCK_MANAGED_AGENT_HELPERS
