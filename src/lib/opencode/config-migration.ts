// FILE: src/lib/opencode/config-migration.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Materialize a legacy V1 OpenCode configuration into the native V2 shape described by the official V1-to-V2 migration guide, with a timestamped backup and a validate-before-write guarantee.
//   SCOPE: V1-shape classification, guide-aligned top-level and nested transformation planning with wholly-or-not-at-all nested entries, report-only field detection, vvoc role-reference removal, native codec validation, and atomic backup-plus-write orchestration.
//   DEPENDS: [jsonc-parser, node:path, src/lib/opencode/shared-utils.ts, src/lib/opencode/paths.ts]
//   LINKS: [M-CLI-CONFIG, V-M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MigrationShape - Classification result tag for an OpenCode document.
//   MigrationClassification - Shape plus the V1 signals that produced it.
//   OpenCodeConfigMigrationPlan - Planned native document, change flag, and report-only/unmappable field lists.
//   OpenCodeConfigMigrationResult - Outcome of a migration attempt against a resolved path bundle.
//   classifyOpenCodeConfig - Classifies a document as native-clean or V1-shaped.
//   planOpenCodeConfigMigration - Builds the native target document and the report-only/unmappable lists.
//   migrateOpenCodeConfig - Reads, plans, validates, backs up, and writes the migrated OpenCode config.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-V1-OPENCODE-CONFIG-MIGRATION T-001 - Added the guide-aligned V1-to-V2 OpenCode config materializer with backup and validate-before-write.]
// END_CHANGE_SUMMARY

import { applyEdits, modify } from "jsonc-parser";
import { dirname, join } from "node:path";
import {
  assertNativeOpenCodeDocument,
  ensureTrailingNewline,
  isJsonObject,
  normalizeNativeModelSelection,
  OPENCODE_SCHEMA_URL,
  parseObjectDocument,
  readOptionalText,
  writeText,
  type JsonObject,
} from "./shared-utils.js";
import type { ResolvedPaths } from "./paths.js";

const TOP_LEVEL_V1_KEYS = [
  "plugin",
  "agent",
  "mode",
  "provider",
  "command",
  "small_model",
  "tools",
  "permission",
  "reference",
  "snapshot",
  "attachment",
  "autoshare",
  "autoupdate",
] as const;

/** V1 top-level fields that have no supported native behavior and are reported, never converted. */
const REPORT_ONLY_TOP_LEVEL = [
  "enabled_providers",
  "disabled_providers",
  "logLevel",
  "server",
  "subagent_depth",
  "batch_tool",
  "openTelemetry",
  "primary_tools",
  "continue_loop_on_deny",
] as const;

const PROVIDER_ID_RENAMES: Readonly<Record<string, string>> = {
  "azure-cognitive-services": "azure",
  "google-vertex-anthropic": "google-vertex",
};

const PERMISSION_ACTION_RENAMES: Readonly<Record<string, string>> = {
  bash: "shell",
  task: "subagent",
  write: "edit",
  patch: "edit",
};

/** V1 provider fields without a native equivalent. */
const PROVIDER_REPORT_ONLY_FIELDS = ["id", "whitelist", "blacklist"] as const;

/** V1 provider-model fields without a native equivalent. */
const PROVIDER_MODEL_LEGACY_FIELDS = [
  "release_date",
  "attachment",
  "reasoning",
  "temperature",
  "experimental",
  "interleaved",
] as const;

const JSON_FORMAT = { insertSpaces: true, tabSize: 2, eol: "\n" } as const;

export type MigrationShape = "native-clean" | "v1";

export type MigrationClassification = {
  shape: MigrationShape;
  reasons: string[];
};

export type OpenCodeConfigMigrationPlan = {
  document: JsonObject;
  changed: boolean;
  reportOnly: string[];
  unmappable: string[];
};

export type OpenCodeConfigMigrationResult = {
  path: string;
  action: "migrated" | "kept" | "aborted";
  backupPath?: string;
  reportOnly: string[];
  unmappable: string[];
  legacyTuiPaths: string[];
};

type Collector = { reportOnly: string[]; unmappable: string[] };

function isRoleReference(value: unknown): boolean {
  return typeof value === "string" && value.trim().startsWith("vv-role:");
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneJson(entry)) as unknown as T;
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) out[key] = cloneJson(entry);
    return out as unknown as T;
  }
  return value;
}

function asObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

// START_CONTRACT: classifyOpenCodeConfig
//   PURPOSE: Determine whether a parsed OpenCode document still carries V1 shapes that need materialization.
//   INPUTS: { document: JsonObject - parsed OpenCode config document. }
//   OUTPUTS: { MigrationClassification - shape plus the V1 signals observed. }
//   SIDE_EFFECTS: none
//   LINKS: [fn-planOpenCodeConfigMigration]
// END_CONTRACT: classifyOpenCodeConfig
export function classifyOpenCodeConfig(document: JsonObject): MigrationClassification {
  const reasons: string[] = [];

  for (const key of TOP_LEVEL_V1_KEYS) {
    if (Object.hasOwn(document, key)) reasons.push(`top-level V1 field "${key}"`);
  }
  for (const key of REPORT_ONLY_TOP_LEVEL) {
    if (Object.hasOwn(document, key)) reasons.push(`report-only field "${key}"`);
  }
  if (isRoleReference(document.model)) reasons.push('role reference in "model"');
  if (Object.hasOwn(document, "small_model")) reasons.push('top-level V1 field "small_model"');

  const agents = asObject(document.agents);
  for (const [name, entry] of Object.entries(agents)) {
    if (!isJsonObject(entry)) continue;
    if (
      Object.hasOwn(entry, "prompt") ||
      Object.hasOwn(entry, "permission") ||
      Object.hasOwn(entry, "tools")
    ) {
      reasons.push(`V1 agent field in "agents.${name}"`);
    }
    if (isRoleReference(entry.model)) reasons.push(`role reference in "agents.${name}.model"`);
  }

  if (
    isJsonObject(document.skills) &&
    (Object.hasOwn(document.skills, "paths") || Object.hasOwn(document.skills, "urls"))
  ) {
    reasons.push('V1 "skills" object form');
  }

  return { shape: reasons.length > 0 ? "v1" : "native-clean", reasons };
}

function convertPermissionMap(permission: unknown, collector: Collector): JsonObject[] {
  const entries: JsonObject[] = [];
  if (permission === undefined) return entries;
  if (!isJsonObject(permission)) {
    collector.unmappable.push('"permission" is not an object');
    return entries;
  }

  for (const [rawAction, value] of Object.entries(permission)) {
    const action = PERMISSION_ACTION_RENAMES[rawAction] ?? rawAction;
    if (isJsonObject(value)) {
      for (const [resource, effect] of Object.entries(value)) {
        if (typeof effect !== "string") {
          collector.unmappable.push(`"permission.${rawAction}.${resource}" effect is not a string`);
          continue;
        }
        entries.push({ action, resource, effect });
      }
      continue;
    }
    if (typeof value === "string") {
      entries.push({ action, resource: "*", effect: value });
      continue;
    }
    collector.unmappable.push(
      `"permission.${rawAction}" is neither an effect string nor an object`,
    );
  }
  return entries;
}

function convertToolsMap(tools: unknown, collector: Collector): JsonObject[] {
  const entries: JsonObject[] = [];
  if (tools === undefined) return entries;
  if (!isJsonObject(tools)) {
    collector.unmappable.push('"tools" is not an object');
    return entries;
  }

  for (const [rawAction, value] of Object.entries(tools)) {
    if (typeof value !== "boolean") {
      collector.unmappable.push(`"tools.${rawAction}" is not a boolean`);
      continue;
    }
    entries.push({
      action: PERMISSION_ACTION_RENAMES[rawAction] ?? rawAction,
      resource: "*",
      effect: value ? "allow" : "deny",
    });
  }
  return entries;
}

function convertAgentEntry(
  name: string,
  entry: unknown,
  collector: Collector,
): JsonObject | undefined {
  if (!isJsonObject(entry)) {
    collector.unmappable.push(`"agents.${name}" is not an object`);
    return undefined;
  }

  const out: JsonObject = {};
  let variant: string | undefined;
  for (const [key, value] of Object.entries(entry)) {
    if (key === "prompt") {
      out.system = value;
    } else if (key === "disable") {
      out.disabled = value;
    } else if (key === "maxSteps") {
      out.steps = value;
    } else if (key === "variant") {
      if (typeof value === "string") variant = value;
      else collector.unmappable.push(`"agents.${name}.variant" is not a string`);
    } else if (key === "temperature" || key === "top_p" || key === "options") {
      const request = asObject(out.request);
      const body = asObject(request.body);
      if (key === "options" && isJsonObject(value)) {
        request.body = { ...body, ...value };
      } else {
        body[key] = value;
        request.body = body;
      }
      out.request = request;
    } else if (key === "permission") {
      const converted = convertPermissionMap(value, collector);
      if (converted.length > 0) out.permissions = converted;
    } else if (key === "tools") {
      const converted = convertToolsMap(value, collector);
      if (converted.length > 0)
        out.permissions = [
          ...(Array.isArray(out.permissions) ? out.permissions : []),
          ...converted,
        ];
    } else if (key === "model") {
      if (isRoleReference(value)) {
        // vvoc role intent; rebuilt from vvoc config by the existing pipeline.
        continue;
      }
      out.model = value;
    } else {
      out[key] = value;
    }
  }

  if (variant !== undefined && typeof out.model === "string" && !out.model.includes("#")) {
    out.model = `${out.model}#${variant}`;
  } else if (variant !== undefined && out.model === undefined) {
    collector.unmappable.push(`"agents.${name}.variant" has no model to join`);
  } else if (variant !== undefined) {
    collector.unmappable.push(`"agents.${name}.variant" cannot join a non-string model`);
  }

  return out;
}

function convertCommandEntry(
  name: string,
  entry: unknown,
  collector: Collector,
): JsonObject | undefined {
  if (!isJsonObject(entry)) {
    collector.unmappable.push(`"commands.${name}" is not an object`);
    return undefined;
  }

  const out: JsonObject = {};
  let variant: string | undefined;
  for (const [key, value] of Object.entries(entry)) {
    if (key === "subtask") {
      out.subagent = value;
    } else if (key === "variant") {
      if (typeof value === "string") variant = value;
      else collector.unmappable.push(`"commands.${name}.variant" is not a string`);
    } else if (key === "model") {
      out.model = value;
    } else {
      out[key] = value;
    }
  }

  if (variant !== undefined && typeof out.model === "string" && !out.model.includes("#")) {
    out.model = `${out.model}#${variant}`;
  } else if (variant !== undefined) {
    collector.unmappable.push(`"commands.${name}.variant" cannot join a non-string model`);
  }

  return out;
}

function convertProviderModel(
  id: string,
  entry: unknown,
  collector: Collector,
): JsonObject | undefined {
  if (!isJsonObject(entry)) {
    collector.unmappable.push(`"providers.${id}.models" entry is not an object`);
    return undefined;
  }

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "id") {
      out.modelID = value;
    } else if (key === "tool_call") {
      out.capabilities = { ...asObject(out.capabilities), tools: value };
    } else if (key === "modalities") {
      if (isJsonObject(value)) {
        out.capabilities = { ...asObject(out.capabilities), ...value };
      } else {
        collector.unmappable.push(`"providers.${id}.models.modalities" is not an object`);
      }
    } else if (key === "status") {
      if (value === "deprecated") out.disabled = true;
      else collector.reportOnly.push(`"providers.${id}.models.status" non-deprecated value`);
    } else if (key === "cache_read") {
      out.cache = { ...asObject(out.cache), read: value };
    } else if (key === "cache_write") {
      out.cache = { ...asObject(out.cache), write: value };
    } else if (key === "options") {
      out.settings = { ...asObject(out.settings), ...asObject(value) };
    } else if (key === "variants") {
      if (isJsonObject(value)) {
        out.variants = Object.entries(value).map(([variantId, settings]) => ({
          id: variantId,
          settings: asObject(settings),
        }));
      } else {
        collector.unmappable.push(`"providers.${id}.models.variants" is not an object`);
      }
    } else if ((PROVIDER_MODEL_LEGACY_FIELDS as readonly string[]).includes(key)) {
      collector.reportOnly.push(`"providers.${id}.models.${key}"`);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function convertProviderEntry(
  id: string,
  entry: unknown,
  collector: Collector,
): JsonObject | undefined {
  if (!isJsonObject(entry)) {
    collector.unmappable.push(`"providers.${id}" is not an object`);
    return undefined;
  }

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "npm") {
      const spec = typeof value === "string" ? value : undefined;
      if (spec === undefined) collector.unmappable.push(`"providers.${id}.npm" is not a string`);
      else out.package = spec.includes(":") ? spec : `aisdk:${spec}`;
    } else if (key === "api") {
      out.settings = { ...asObject(out.settings), baseURL: value };
    } else if (key === "options") {
      out.settings = { ...asObject(out.settings), ...asObject(value) };
    } else if (key === "models") {
      if (isJsonObject(value)) {
        const models: JsonObject = {};
        for (const [modelId, modelEntry] of Object.entries(value)) {
          const converted = convertProviderModel(`${id}.${modelId}`, modelEntry, collector);
          if (converted !== undefined) models[modelId] = converted;
        }
        out.models = models;
      } else {
        collector.unmappable.push(`"providers.${id}.models" is not an object`);
      }
    } else if ((PROVIDER_REPORT_ONLY_FIELDS as readonly string[]).includes(key)) {
      collector.reportOnly.push(`"providers.${id}.${key}"`);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const MCP_OAUTH_SNAKE_CASE: Readonly<Record<string, string>> = {
  clientId: "client_id",
  clientSecret: "client_secret",
  callbackPort: "callback_port",
  redirectUri: "redirect_uri",
};

function convertMcpServer(
  name: string,
  entry: unknown,
  collector: Collector,
): JsonObject | undefined {
  if (!isJsonObject(entry)) {
    collector.unmappable.push(`"mcp.servers.${name}" is not an object`);
    return undefined;
  }
  if (!Object.hasOwn(entry, "type") && Object.hasOwn(entry, "enabled")) {
    collector.reportOnly.push(`"mcp.${name}" enabled-only entry without a type`);
    return undefined;
  }

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "enabled") {
      out.disabled = value === true ? false : true;
    } else if (key === "timeout") {
      out.timeout = typeof value === "number" ? { catalog: value, execution: value } : value;
    } else if (MCP_OAUTH_SNAKE_CASE[key] !== undefined) {
      out[MCP_OAUTH_SNAKE_CASE[key]] = value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function convertMcp(mcp: unknown, collector: Collector): JsonObject | undefined {
  if (!isJsonObject(mcp)) {
    collector.unmappable.push('"mcp" is not an object');
    return undefined;
  }
  if (isJsonObject(mcp.servers)) {
    // Already native.
    return mcp;
  }

  const servers: JsonObject = {};
  for (const [name, entry] of Object.entries(mcp)) {
    const converted = convertMcpServer(name, entry, collector);
    if (converted !== undefined) servers[name] = converted;
  }
  return { servers };
}

function convertCompaction(compaction: unknown, collector: Collector): JsonObject | undefined {
  if (!isJsonObject(compaction)) {
    collector.unmappable.push('"compaction" is not an object');
    return undefined;
  }

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(compaction)) {
    if (key === "preserve_recent_tokens") {
      out.keep = { ...asObject(out.keep), tokens: value };
    } else if (key === "reserved") {
      out.buffer = value;
    } else if (key === "tail_turns" || key === "prune") {
      collector.reportOnly.push(`"compaction.${key}"`);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function convertSkills(skills: unknown, collector: Collector): string[] | undefined {
  if (Array.isArray(skills)) return skills.slice() as string[];
  if (!isJsonObject(skills)) {
    collector.unmappable.push('"skills" is neither an array nor an object');
    return undefined;
  }
  const result: string[] = [];
  for (const key of ["paths", "urls"] as const) {
    const value = skills[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      collector.unmappable.push(`"skills.${key}" is not an array of strings`);
      continue;
    }
    result.push(...(value as string[]));
  }
  return result;
}

function convertAutoshare(value: unknown): string | undefined {
  if (value === true) return "auto";
  if (value === false) return "disabled";
  return undefined;
}

function convertAutoupdate(value: unknown): string | undefined {
  if (value === true) return "auto";
  if (value === false) return "disable";
  if (value === "notify") return "notify";
  return undefined;
}

// START_CONTRACT: planOpenCodeConfigMigration
//   PURPOSE: Build the native V2 target document from a V1 document, collecting report-only and unmappable fields.
//   INPUTS: { document: JsonObject - parsed OpenCode config document. }
//   OUTPUTS: { OpenCodeConfigMigrationPlan - native target, change flag, and report-only/unmappable lists. }
//   SIDE_EFFECTS: none
//   LINKS: [fn-classifyOpenCodeConfig, fn-migrateOpenCodeConfig]
// END_CONTRACT: planOpenCodeConfigMigration
export function planOpenCodeConfigMigration(document: JsonObject): OpenCodeConfigMigrationPlan {
  const collector: Collector = { reportOnly: [], unmappable: [] };
  const out: JsonObject = {};

  const handled = new Set<string>([...TOP_LEVEL_V1_KEYS, ...REPORT_ONLY_TOP_LEVEL, "model"]);

  // Copy unrelated fields first.
  for (const [key, value] of Object.entries(document)) {
    if (!handled.has(key)) out[key] = cloneJson(value);
  }

  for (const key of REPORT_ONLY_TOP_LEVEL) {
    if (Object.hasOwn(document, key)) collector.reportOnly.push(`"${key}"`);
  }

  out.$schema = OPENCODE_SCHEMA_URL;

  // plugins: rename plugin and convert V1 tuples to {package, options} objects.
  const rawPlugins = document.plugins ?? document.plugin;
  if (rawPlugins !== undefined) {
    if (!Array.isArray(rawPlugins)) {
      collector.unmappable.push('"plugins" is not an array');
    } else {
      const plugins: unknown[] = [];
      for (const entry of rawPlugins) {
        if (typeof entry === "string") {
          plugins.push(entry);
        } else if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string") {
          plugins.push(
            isJsonObject(entry[1])
              ? { package: entry[0], options: entry[1] }
              : { package: entry[0] },
          );
        } else if (isJsonObject(entry)) {
          plugins.push(entry);
        } else {
          collector.unmappable.push('"plugins" entry is neither a string, tuple, nor object');
        }
      }
      out.plugins = plugins;
    }
  }

  // agents: merge agent and mode maps, converting each entry wholly.
  const sourceAgents = asObject(document.agents);
  const legacyAgentMap = document.agent;
  const legacyModeMap = document.mode;
  if (legacyAgentMap !== undefined && !isJsonObject(legacyAgentMap))
    collector.unmappable.push('"agent" is not an object');
  if (legacyModeMap !== undefined && !isJsonObject(legacyModeMap))
    collector.unmappable.push('"mode" is not an object');

  const agents: JsonObject = {};
  const mergeAgentMap = (map: unknown, forcePrimary: boolean): void => {
    if (!isJsonObject(map)) return;
    for (const [name, entry] of Object.entries(map)) {
      const converted = convertAgentEntry(name, entry, collector);
      if (converted === undefined) continue;
      if (forcePrimary && !Object.hasOwn(converted, "mode")) converted.mode = "primary";
      agents[name] = converted;
    }
  };
  mergeAgentMap(sourceAgents, false);
  mergeAgentMap(legacyAgentMap, false);
  mergeAgentMap(legacyModeMap, true);

  // small_model / title agent.
  if (Object.hasOwn(document, "small_model")) {
    const small = document.small_model;
    if (isRoleReference(small)) {
      // dropped; rebuilt as modelIntent
    } else {
      const selection = normalizeNativeModelSelection(small, "small_model");
      if (selection !== undefined) {
        const title = asObject(agents.title);
        agents.title = { ...title, model: selection };
      }
    }
  }
  if (Object.keys(agents).length > 0) out.agents = agents;

  // commands
  const legacyCommands = document.command;
  if (legacyCommands !== undefined) {
    if (!isJsonObject(legacyCommands)) {
      collector.unmappable.push('"command" is not an object');
    } else {
      const commands: JsonObject = {};
      for (const [name, entry] of Object.entries(legacyCommands)) {
        const converted = convertCommandEntry(name, entry, collector);
        if (converted !== undefined) commands[name] = converted;
      }
      out.commands = commands;
    }
  }

  // providers
  const legacyProviders = document.provider;
  if (legacyProviders !== undefined) {
    if (!isJsonObject(legacyProviders)) {
      collector.unmappable.push('"provider" is not an object');
    } else {
      const providers: JsonObject = {};
      for (const [id, entry] of Object.entries(legacyProviders)) {
        const canonical = PROVIDER_ID_RENAMES[id] ?? id;
        const converted = convertProviderEntry(canonical, entry, collector);
        if (converted !== undefined) providers[canonical] = converted;
      }
      out.providers = providers;
    }
  }

  // permissions from permission and tools
  const permissions = [
    ...convertPermissionMap(document.permission, collector),
    ...convertToolsMap(document.tools, collector),
  ];
  if (permissions.length > 0) {
    const existing = Array.isArray(out.permissions) ? (out.permissions as unknown[]) : [];
    out.permissions = [...existing, ...permissions];
  }

  // skills
  if (document.skills !== undefined) {
    const skills = convertSkills(document.skills, collector);
    if (skills !== undefined) out.skills = skills;
  }

  // mcp
  if (document.mcp !== undefined) {
    const mcp = convertMcp(document.mcp, collector);
    if (mcp !== undefined) out.mcp = mcp;
  }

  // compaction
  if (document.compaction !== undefined) {
    const compaction = convertCompaction(document.compaction, collector);
    if (compaction !== undefined) out.compaction = compaction;
  }

  // simple renames
  if (document.reference !== undefined) out.references = cloneJson(document.reference);
  if (document.snapshot !== undefined) out.snapshots = document.snapshot;
  if (document.attachment !== undefined) out.media = cloneJson(document.attachment);
  if (document.autoshare !== undefined) {
    const share = convertAutoshare(document.autoshare);
    if (share === undefined) collector.reportOnly.push('"autoshare"');
    else out.share = share;
  }
  if (document.autoupdate !== undefined) {
    const update = convertAutoupdate(document.autoupdate);
    if (update === undefined) collector.reportOnly.push('"autoupdate"');
    else out.update = update;
  }

  // root model role reference is dropped (rebuilt as modelIntent); native model strings are preserved.
  if (document.model !== undefined && !isRoleReference(document.model)) {
    out.model = cloneJson(document.model);
  }

  const changed = JSON.stringify(out) !== JSON.stringify(document);
  return {
    document: out,
    changed,
    reportOnly: collector.reportOnly,
    unmappable: collector.unmappable,
  };
}

function renderMigratedText(text: string, before: JsonObject, after: JsonObject): string {
  // Edit top-level keys individually so comments and formatting attached to
  // unchanged keys survive; only changed keys and removed V1 keys are touched.
  let next = text;
  for (const key of Object.keys(before)) {
    if (!Object.hasOwn(after, key)) {
      next = applyEdits(next, modify(next, [key], undefined, { formattingOptions: JSON_FORMAT }));
    }
  }
  for (const [key, value] of Object.entries(after)) {
    if (Object.hasOwn(before, key) && JSON.stringify(before[key]) === JSON.stringify(value))
      continue;
    next = applyEdits(next, modify(next, [key], value, { formattingOptions: JSON_FORMAT }));
  }
  return ensureTrailingNewline(next);
}

async function detectLegacyTuiPaths(opencodeConfigPath: string): Promise<string[]> {
  const baseDir = dirname(opencodeConfigPath);
  const found: string[] = [];
  for (const name of ["tui.json", "tui.jsonc"]) {
    const candidate = join(baseDir, name);
    if ((await readOptionalText(candidate)) !== undefined) found.push(candidate);
  }
  return found;
}

// START_CONTRACT: migrateOpenCodeConfig
//   PURPOSE: Read an OpenCode config, materialize the native V2 document when V1-shaped, back it up, and write it only when valid.
//   INPUTS: { paths: ResolvedPaths - resolved OpenCode config path bundle. }
//   OUTPUTS: { OpenCodeConfigMigrationResult - action, backup path, and field lists. }
//   SIDE_EFFECTS: Writes a timestamped sibling backup and the migrated config atomically; never touches a legacy tui.json(c).
//   LINKS: [fn-classifyOpenCodeConfig, fn-planOpenCodeConfigMigration]
// END_CONTRACT: migrateOpenCodeConfig
export async function migrateOpenCodeConfig(
  paths: ResolvedPaths,
): Promise<OpenCodeConfigMigrationResult> {
  const legacyTuiPaths = await detectLegacyTuiPaths(paths.opencodeConfigPath);
  const currentText = await readOptionalText(paths.opencodeConfigPath);

  if (currentText === undefined || !currentText.trim()) {
    return {
      path: paths.opencodeConfigPath,
      action: "kept",
      reportOnly: [],
      unmappable: [],
      legacyTuiPaths,
    };
  }

  const document = parseObjectDocument(currentText, "OpenCode config");
  const classification = classifyOpenCodeConfig(document);
  if (classification.shape === "native-clean") {
    return {
      path: paths.opencodeConfigPath,
      action: "kept",
      reportOnly: [],
      unmappable: [],
      legacyTuiPaths,
    };
  }

  const plan = planOpenCodeConfigMigration(document);
  if (plan.unmappable.length > 0 || plan.reportOnly.length > 0) {
    return {
      path: paths.opencodeConfigPath,
      action: "aborted",
      reportOnly: plan.reportOnly,
      unmappable: plan.unmappable,
      legacyTuiPaths,
    };
  }

  // Validate the planned document against the pinned native codec before any write.
  const nextText = renderMigratedText(currentText, document, plan.document);
  const reparsed = parseObjectDocument(nextText, "OpenCode config");
  assertNativeOpenCodeDocument(reparsed, "OpenCode config", {
    configDir: dirname(paths.opencodeConfigPath),
  });

  if (nextText === currentText) {
    return {
      path: paths.opencodeConfigPath,
      action: "kept",
      reportOnly: [],
      unmappable: [],
      legacyTuiPaths,
    };
  }

  const backupPath = `${paths.opencodeConfigPath}.vvoc-backup-${Date.now()}`;
  await writeText(backupPath, currentText);
  await writeText(paths.opencodeConfigPath, nextText);

  return {
    path: paths.opencodeConfigPath,
    action: "migrated",
    backupPath,
    reportOnly: [],
    unmappable: [],
    legacyTuiPaths,
  };
}
