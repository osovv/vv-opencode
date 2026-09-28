// FILE: src/lib/opencode/agent-registrations.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Conservative vvoc-managed native OpenCode agent markdown, managed skills registration, and managed agent model IO.
//   SCOPE: Native `default_agent`/`skills` config registration, native discovered agent markdown generation with native frontmatter, managed prompt/skill file install and sync with managed-marker guards, the OpenCode skills symlink, and read/write of managed agent model overrides. Generic model/default-model/provider overrides live in model-overrides.ts.
//   DEPENDS: [jsonc-parser, node:fs/promises, node:path, src/lib/managed-agents.ts, src/lib/managed-skills.ts, src/lib/model-roles.ts, src/lib/opencode/shared-utils.ts, src/lib/opencode/paths.ts]
//   LINKS: [M-CLI-CONFIG, M-CLI-MANAGED-AGENTS, M-CLI-MANAGED-SKILLS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ManagedAgentModelMap - Map of managed agent names to model selections.
//   ManagedAgentOverrideMap - Map of agent override configs.
//   ensureManagedAgentRegistrationsConfigText - Ensures native OpenCode config contains the managed default agent and skills registration.
//   syncManagedAgentRegistrations - Syncs the canonical native default agent and managed skills registration into OpenCode config.
//   installManagedAgentPrompts - Creates managed native agent markdown and the guardian prompt body when missing.
//   syncManagedAgentPrompts - Rewrites managed native agent markdown and the guardian prompt body.
//   installManagedSkillFiles - Creates managed vvoc skill files from bundled templates.
//   syncManagedSkillFiles - Rewrites managed vvoc skill files from bundled templates.
//   ensureManagedSkillSymlink - Creates symlink from the native OpenCode skills dir to the vvoc skills dir for skill discovery.
//   readManagedAgentModels - Reads model overrides for the bundled vvoc-managed OpenCode agents from native config.
//   readManagedAgentOverrides - Reads model overrides for the bundled vvoc-managed OpenCode agents.
//   writeManagedAgentModel - Writes or removes a bundled vvoc-managed OpenCode agent model override in native config.
//   readAgentMap - Reads the native `agents` object map from a parsed OpenCode config.
//   ensureAgentConfigText - Ensures an OpenCode config document with a native `agents` object exists.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-007 - Replaced V1 inline agent prompt/permission registration with native discovered agent markdown plus native default_agent and skills registration.]
// END_CHANGE_SUMMARY

import { applyEdits, format, modify } from "jsonc-parser";
import { lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  MANAGED_NATIVE_AGENT_NAMES,
  MANAGED_OPENCODE_AGENTS,
  type ManagedAgentPromptName,
  getManagedAgentPromptPath,
  getManagedNativeAgentFrontmatter,
  loadManagedAgentPromptTemplate,
  type ManagedNativeAgentFrontmatter,
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
import {
  assertNativeOpenCodeDocument,
  ensureOpenCodeConfigText,
  ensureTrailingNewline,
  hasYamlFrontmatter,
  isManagedFile,
  OPENCODE_SCHEMA_URL,
  parseObjectDocument,
  readAgentOverride,
  readNativeAgents,
  readOptionalText,
  readSkillsArray,
  removeTextFile,
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
    "managedSkillsDirPath" | "opencodeConfigPath" | "opencodeBaseDir" | "scope" | "projectRoot"
  >,
): string {
  const managedSkillsPath = getManagedSkillsPathReference(paths);

  if (!text?.trim()) {
    return renderJson({
      $schema: OPENCODE_SCHEMA_URL,
      default_agent: MANAGED_DEFAULT_AGENT,
      skills: [managedSkillsPath],
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

  if (document.default_agent !== MANAGED_DEFAULT_AGENT) {
    nextText = applyEdits(
      nextText,
      modify(nextText, ["default_agent"], MANAGED_DEFAULT_AGENT, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  nextText = ensureManagedSkillsPathConfigText(nextText, paths);

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

// START_BLOCK_MANAGED_AGENT_MARKDOWN
/** Managed frontmatter keys vvoc generates by default; users may override them. */
const MANAGED_AGENT_FRONTMATTER_KEYS = new Set([
  "description",
  "mode",
  "hidden",
  "steps",
  "permissions",
]);

/**
 * Renders a native discovered agent markdown file. Native frontmatter keys the
 * user defined inline are omitted so the inline registration stays effective,
 * and an existing managed file's frontmatter is preserved verbatim as
 * user-owned while only the managed body is refreshed. The
 * `<!-- Managed by vvoc ... -->` header stays in the body so `isManagedFile`
 * can distinguish vvoc-managed bodies.
 */
function renderNativeAgentMarkdown(
  agentName: ManagedAgentPromptName,
  template: string,
  options: {
    preservedFrontmatter?: string | undefined;
    omitKeys?: ReadonlySet<string> | undefined;
  } = {},
): string {
  const inner =
    options.preservedFrontmatter !== undefined && options.preservedFrontmatter !== ""
      ? stripFrontmatterKeys(options.preservedFrontmatter.replace(/\n+$/, ""), options.omitKeys)
      : renderNativeAgentFrontmatterInner(
          getManagedNativeAgentFrontmatter(agentName),
          options.omitKeys,
        );
  const body = stripMarkdownFrontmatter(template).trim();
  return `---\n${inner}\n---\n${MANAGED_FILE_HEADER}${body}\n`;
}

/**
 * Removes only the named top-level frontmatter keys (and their indented
 * continuation lines) so an inline override wins without wiping the user's
 * other preserved keys.
 */
function stripFrontmatterKeys(inner: string, omitKeys?: ReadonlySet<string>): string {
  if (omitKeys === undefined || omitKeys.size === 0) return inner;
  const out: string[] = [];
  let skipping = false;
  for (const line of inner.split("\n")) {
    const topKey = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line);
    if (topKey !== null) {
      skipping = omitKeys.has(topKey[1]);
      if (skipping) continue;
      out.push(line);
      continue;
    }
    if (skipping && (line.startsWith(" ") || line.startsWith("\t") || line.trim() === "")) {
      continue;
    }
    skipping = false;
    out.push(line);
  }
  return out.join("\n").replace(/\n+$/, "");
}

/** Returns the inner frontmatter text of a markdown file, without the `---` fences. */
function extractFrontmatterBlock(text: string): string | undefined {
  const match = text.replaceAll("\r\n", "\n").match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  return match?.[1];
}

const MANAGED_FILE_HEADER = [
  "<!-- Managed by vvoc.",
  "`vvoc sync` rewrites files with this marker while preserving agent registration and model settings elsewhere.",
  "Remove this comment if you want to manage the file manually.",
  "-->",
  "",
].join("\n");

function renderNativeAgentFrontmatterInner(
  frontmatter: ManagedNativeAgentFrontmatter,
  omitKeys?: ReadonlySet<string>,
): string {
  const omit = (key: string) => omitKeys?.has(key) === true;
  const lines: string[] = [];
  if (!omit("description")) lines.push(`description: ${quoteYaml(frontmatter.description)}`);
  if (!omit("mode")) lines.push(`mode: ${frontmatter.mode}`);
  if (frontmatter.hidden !== undefined && !omit("hidden")) {
    lines.push(`hidden: ${frontmatter.hidden ? "true" : "false"}`);
  }
  if (frontmatter.steps !== undefined && !omit("steps")) {
    lines.push(`steps: ${frontmatter.steps}`);
  }
  if (frontmatter.permissions && frontmatter.permissions.length > 0 && !omit("permissions")) {
    lines.push("permissions:");
    for (const rule of frontmatter.permissions) {
      lines.push(`  - action: ${quoteYaml(rule.action)}`);
      lines.push(`    resource: ${quoteYaml(rule.resource)}`);
      lines.push(`    effect: ${quoteYaml(rule.effect)}`);
    }
  }
  return lines.join("\n");
}

/** Canonical inner frontmatter for one managed agent, used to detect user edits. */
function canonicalFrontmatterInner(agentName: ManagedAgentPromptName): string {
  return renderNativeAgentFrontmatterInner(getManagedNativeAgentFrontmatter(agentName));
}

function isCanonicalManagedFrontmatter(text: string, agentName: ManagedAgentPromptName): boolean {
  const inner = extractFrontmatterBlock(text);
  if (inner === undefined) return false;
  return inner.replace(/\n+$/, "") === canonicalFrontmatterInner(agentName).replace(/\n+$/, "");
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

type InlineAgentOverride = {
  definesSystem: boolean;
  managedKeys: Set<string>;
};

/** Reads native inline `agents.<id>` overrides that must stay effective over generated markdown. */
async function readInlineManagedAgentOverrides(
  paths: Pick<ResolvedPaths, "opencodeConfigPath">,
): Promise<Map<ManagedAgentPromptName, InlineAgentOverride>> {
  const overrides = new Map<ManagedAgentPromptName, InlineAgentOverride>();
  const text = await readOptionalText(paths.opencodeConfigPath);
  if (!text) return overrides;
  let agents: Record<string, JsonObject>;
  try {
    const document = parseObjectDocument(text, paths.opencodeConfigPath);
    agents = readNativeAgents(document, paths.opencodeConfigPath);
  } catch {
    return overrides;
  }
  for (const agentName of MANAGED_NATIVE_AGENT_NAMES) {
    const entry = agents[agentName];
    if (!entry) continue;
    overrides.set(agentName, {
      definesSystem: Object.hasOwn(entry, "system"),
      managedKeys: new Set(
        Object.keys(entry).filter((key) => MANAGED_AGENT_FRONTMATTER_KEYS.has(key)),
      ),
    });
  }
  return overrides;
}

type InlineSystemAction = "skip" | "delete";

/**
 * Reconciles inline `agents.<id>.system` overrides with generated markdown.
 * Native markdown loads after inline JSON and would shadow the inline system,
 * so a canonical vvoc-managed file is removed (vvoc-owned and regenerable) and
 * a user-customized file fails closed before any write instead of guessing.
 */
async function resolveInlineSystemActions(
  paths: Pick<ResolvedPaths, "managedAgentsDirPath">,
  inlineOverrides: Map<ManagedAgentPromptName, InlineAgentOverride>,
): Promise<Map<string, InlineSystemAction>> {
  const actions = new Map<string, InlineSystemAction>();
  for (const [agentName, override] of inlineOverrides) {
    if (!override.definesSystem) continue;
    const agentPath = getManagedAgentPromptPath(paths.managedAgentsDirPath, agentName);
    const text = await readOptionalText(agentPath);
    if (!text || !isManagedFile(text)) {
      actions.set(agentName, "skip");
      continue;
    }
    if (isCanonicalManagedFrontmatter(text, agentName)) {
      actions.set(agentName, "delete");
      continue;
    }
    throw new Error(
      `inline agents.${agentName}.system conflicts with the user-customized managed markdown at ${agentPath}; remove one source before syncing`,
    );
  }
  return actions;
}

async function applyInlineSystemAction(
  agentPath: string,
  action: InlineSystemAction,
): Promise<WriteResult[]> {
  if (action === "delete") {
    const removed = await removeTextFile(agentPath);
    return [
      {
        action: removed ? "deleted" : "kept",
        path: agentPath,
        reason: "inline agent registration owns the system prompt",
      },
    ];
  }
  return [
    {
      action: "skipped",
      path: agentPath,
      reason: "inline agent registration owns the system prompt",
    },
  ];
}

export async function installManagedAgentPrompts(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  const inlineOverrides = await readInlineManagedAgentOverrides(paths);
  const inlineSystem = await resolveInlineSystemActions(paths, inlineOverrides);

  for (const agentName of MANAGED_NATIVE_AGENT_NAMES) {
    const agentPath = getManagedAgentPromptPath(paths.managedAgentsDirPath, agentName);
    const systemAction = inlineSystem.get(agentName);
    if (systemAction !== undefined) {
      results.push(...(await applyInlineSystemAction(agentPath, systemAction)));
      continue;
    }
    const override = inlineOverrides.get(agentName);
    const currentText = await readOptionalText(agentPath);
    if (!currentText) {
      await writeText(
        agentPath,
        await renderNativeAgentMarkdownForName(agentName, {
          omitKeys: override?.managedKeys,
        }),
      );
      results.push({ action: "created", path: agentPath });
      continue;
    }

    if (!options.force) {
      if (!isManagedFile(currentText)) {
        results.push({
          action: "skipped",
          path: agentPath,
          reason: "existing file is not managed by vvoc",
        });
      } else {
        results.push({ action: "kept", path: agentPath });
      }
      continue;
    }

    results.push(await syncManagedPrompt(paths, agentName, options, override));
  }

  results.push(
    ...(await syncGuardianPromptBody(paths, { force: options.force, installOnly: true })),
  );

  return results;
}

export async function syncManagedAgentPrompts(
  paths: ResolvedPaths,
  options: { force: boolean },
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  const inlineOverrides = await readInlineManagedAgentOverrides(paths);
  const inlineSystem = await resolveInlineSystemActions(paths, inlineOverrides);

  for (const agentName of MANAGED_NATIVE_AGENT_NAMES) {
    const agentPath = getManagedAgentPromptPath(paths.managedAgentsDirPath, agentName);
    const systemAction = inlineSystem.get(agentName);
    if (systemAction !== undefined) {
      results.push(...(await applyInlineSystemAction(agentPath, systemAction)));
      continue;
    }
    const override = inlineOverrides.get(agentName);
    results.push(await syncManagedPrompt(paths, agentName, options, override));
  }

  results.push(
    ...(await syncGuardianPromptBody(paths, { force: options.force, installOnly: false })),
  );

  return results;
}

async function renderNativeAgentMarkdownForName(
  agentName: ManagedAgentPromptName,
  options: {
    preservedFrontmatter?: string | undefined;
    omitKeys?: ReadonlySet<string> | undefined;
  } = {},
): Promise<string> {
  return renderNativeAgentMarkdown(
    agentName,
    await loadManagedAgentPromptTemplate(agentName),
    options,
  );
}

async function syncManagedPrompt(
  paths: ResolvedPaths,
  agentName: ManagedAgentPromptName,
  options: { force: boolean },
  inlineOverride?: InlineAgentOverride | undefined,
): Promise<WriteResult> {
  const agentPath = getManagedAgentPromptPath(paths.managedAgentsDirPath, agentName);
  const currentText = await readOptionalText(agentPath);
  if (!currentText) {
    await writeText(
      agentPath,
      await renderNativeAgentMarkdownForName(agentName, {
        omitKeys: inlineOverride?.managedKeys,
      }),
    );
    return { action: "created", path: agentPath };
  }

  if (!options.force && !isManagedFile(currentText)) {
    return {
      action: "skipped",
      path: agentPath,

      reason: "existing file is not managed by vvoc",
    };
  }

  // Preserve user-owned frontmatter while refreshing the managed body.
  const preservedFrontmatter = isManagedFile(currentText)
    ? extractFrontmatterBlock(currentText)
    : undefined;
  const nextText = await renderNativeAgentMarkdownForName(agentName, {
    preservedFrontmatter,
    omitKeys: inlineOverride?.managedKeys,
  });
  if (currentText === nextText) {
    return { action: "kept", path: agentPath };
  }

  await writeText(agentPath, nextText);
  return { action: "updated", path: agentPath };
}

/**
 * The Guardian plugin loads `.vvoc/agents/guardian.md` as raw prompt text, so
 * the prompt body is materialized there separately from the native discovered
 * agent markdown.
 */
async function syncGuardianPromptBody(
  paths: Pick<ResolvedPaths, "vvocAgentsDirPath">,
  options: { force: boolean; installOnly: boolean },
): Promise<WriteResult[]> {
  const guardianPath = getManagedAgentPromptPath(paths.vvocAgentsDirPath, "guardian");
  const currentText = await readOptionalText(guardianPath);
  if (!currentText) {
    await writeText(guardianPath, await renderManagedPrompt("guardian"));
    return [{ action: "created", path: guardianPath }];
  }

  if (!options.force && !isManagedFile(currentText)) {
    return [
      {
        action: "skipped",
        path: guardianPath,
        reason: "existing file is not managed by vvoc",
      },
    ];
  }

  if (options.installOnly) {
    return [{ action: isManagedFile(currentText) ? "kept" : "skipped", path: guardianPath }];
  }

  const nextText = await renderManagedPrompt("guardian");
  if (currentText === nextText) {
    return [{ action: "kept", path: guardianPath }];
  }

  await writeText(guardianPath, nextText);
  return [{ action: "updated", path: guardianPath }];
}

async function renderManagedPrompt(agentName: ManagedAgentPromptName): Promise<string> {
  const template = stripMarkdownFrontmatter(await loadManagedAgentPromptTemplate(agentName)).trim();
  return `${MANAGED_FILE_HEADER}${template}\n`;
}
// END_BLOCK_MANAGED_AGENT_MARKDOWN

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
    | "managedAgentsDirPath"
    | "managedSkillsDirPath"
    | "opencodeConfigPath"
    | "opencodeBaseDir"
    | "scope"
    | "projectRoot"
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

  const nextEntry = { ...currentEntry };

  if (options.model) {
    nextEntry.model = options.model;
  } else {
    delete nextEntry.model;
  }

  const nextText =
    Object.keys(nextEntry).length === 0
      ? removeAgentEntryText(baseText, agentName)
      : updateAgentEntryText(baseText, agentName, nextEntry);

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
  return readNativeAgents(document, label);
}

export function ensureAgentConfigText(text: string | undefined): string {
  return ensureAgentConfigTextInternal(text);
}

function ensureAgentConfigTextInternal(text: string | undefined): string {
  const nextText = ensureOpenCodeConfigText(text);
  const document = parseObjectDocument(nextText, "OpenCode config");
  const currentAgents = readAgentMap(document, "OpenCode config");
  let nextAgentText = nextText;

  if (!Object.hasOwn(document, "agents")) {
    nextAgentText = applyEdits(
      nextAgentText,
      modify(nextAgentText, ["agents"], currentAgents, {
        formattingOptions: JSON_FORMAT,
      }),
    );
  }

  return ensureTrailingNewline(
    applyEdits(nextAgentText, format(nextAgentText, undefined, JSON_FORMAT)),
  );
}

function removeAgentEntryText(text: string, agentName: string): string {
  const nextText = applyEdits(
    text,
    modify(text, ["agents", agentName], undefined, {
      formattingOptions: JSON_FORMAT,
    }),
  );
  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
}

function getManagedSkillsPathReference(
  paths: Pick<
    ResolvedPaths,
    "managedSkillsDirPath" | "opencodeConfigPath" | "scope" | "projectRoot"
  >,
): string {
  // Native resolves relative `skills` entries against the location directory
  // (the project root), not the config file's directory. A global skills
  // directory lives outside the location, so it must be registered absolutely;
  // a project one is registered relative to the project root without leaking
  // the global layer.
  const baseDir =
    paths.scope === "project"
      ? (paths.projectRoot ?? dirname(paths.opencodeConfigPath))
      : undefined;
  if (baseDir === undefined) {
    return paths.managedSkillsDirPath;
  }
  const skillsRef = relative(resolve(baseDir), paths.managedSkillsDirPath).replaceAll("\\", "/");
  return skillsRef.startsWith(".") ? skillsRef : `./${skillsRef}`;
}

function ensureManagedSkillsPathConfigText(
  text: string,
  paths: Pick<
    ResolvedPaths,
    "managedSkillsDirPath" | "opencodeConfigPath" | "scope" | "projectRoot"
  >,
): string {
  const document = parseObjectDocument(text, "OpenCode config");
  const currentPaths = readSkillsArray(document, "OpenCode config");
  const managedSkillsPath = getManagedSkillsPathReference(paths);

  if (currentPaths.includes(managedSkillsPath)) {
    return text;
  }

  const nextPaths = [...currentPaths, managedSkillsPath];
  const nextText = applyEdits(
    text,
    modify(text, ["skills"], nextPaths, {
      formattingOptions: JSON_FORMAT,
    }),
  );

  return ensureTrailingNewline(applyEdits(nextText, format(nextText, undefined, JSON_FORMAT)));
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

async function renderManagedSkill(skillName: ManagedSkillName): Promise<string> {
  return loadManagedSkillTemplate(skillName);
}
// END_BLOCK_MANAGED_AGENT_HELPERS
